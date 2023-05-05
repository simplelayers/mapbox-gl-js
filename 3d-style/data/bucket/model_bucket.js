// @flow

import EXTENT from '../../../src/data/extent.js';
import {register} from '../../../src/util/web_worker_transfer.js';
import loadGeometry from '../../../src/data/load_geometry.js';
import toEvaluationFeature from '../../../src/data/evaluation_feature.js';
import type {EvaluationFeature} from '../../../src/data/evaluation_feature.js';
import EvaluationParameters from '../../../src/style/evaluation_parameters.js';
import Point from '@mapbox/point-geometry';
import type {Mat4} from 'gl-matrix';
import type {CanonicalTileID} from '../../../src/source/tile_id.js';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../../../src/data/bucket.js';

import type Context from '../../../src/gl/context.js';
import type VertexBuffer from '../../../src/gl/vertex_buffer.js';
import type {FeatureStates} from '../../../src/source/source_state.js';
import type {SpritePositions} from '../../../src/util/image.js';
import type {ProjectionSpecification} from '../../../src/style-spec/types.js';
import type {TileTransform} from '../../../src/geo/projection/tile_transform.js';
import type {IVectorTileLayer} from '@mapbox/vector-tile';
import {InstanceVertexArray} from '../../../src/data/array_types.js';
import assert from 'assert';
import {warnOnce} from '../../../src/util/util.js';
import ModelStyleLayer from '../../style/style_layer/model_style_layer.js';
import {rotationScaleYZFlipMatrix} from '../../util/model_util.js';
import {tileToMeter} from '../../../src/geo/mercator_coordinate.js';

class ModelFeature {
    feature: EvaluationFeature;
    instancedDataOffset: number;
    instancedDataCount: number;

    constructor(feature: EvaluationFeature, offset: number) {
        this.feature = feature;
        this.instancedDataOffset = offset;
        this.instancedDataCount = 0;
    }
}

class PerModelAttributes {
    // If node has meshes, instancedDataArray gets an entry for each feature instance (used for all meshes or the node).
    instancedDataArray: InstanceVertexArray;
    instancedDataBuffer: VertexBuffer;
    instancesEvaluatedElevation: Array<number>; // Gets added to DEM elevation of the instance to produce value in instancedDataArray.

    features: Array<ModelFeature>;
    idToFeaturesIndex: {[string | number]: number}; // via this.features, enable lookup instancedDataArray based on feature ID.

    constructor() {
        this.instancedDataArray = new InstanceVertexArray();
        this.instancesEvaluatedElevation = [];
        this.features = [];
        this.idToFeaturesIndex = {};
    }
}

class ModelBucket implements Bucket {
    zoom: number;
    index: number;
    canonical: CanonicalTileID;
    layers: Array<ModelStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<ModelStyleLayer>;
    stateDependentLayerIds: Array<string>;
    hasPattern: boolean;

    instancesPerModel: {string: PerModelAttributes};

    uploaded: boolean;

    tileToMeter: number;
    projection: ProjectionSpecification;

    // elevation is baked into vertex buffer together with evaluated instance translation
    validForExaggeration: number;
    validForDEMTile: ?CanonicalTileID;

    /* $FlowIgnore[incompatible-type-arg] Doesn't need to know about all the implementations */
    constructor(options: BucketParameters<ModelStyleLayer>) {
        this.zoom = options.zoom;
        this.canonical = options.canonical;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.projection = options.projection;
        this.index = options.index;

        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
        this.hasPattern = false;
        this.instancesPerModel = {};
        this.validForExaggeration = 0;
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters, canonical: CanonicalTileID, tileTransform: TileTransform) {
        this.tileToMeter = tileToMeter(canonical);
        const needGeometry = this.layers[0]._featureFilter.needGeometry;

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            // $FlowFixMe[method-unbinding]
            if (!this.layers[0]._featureFilter.filter(new EvaluationParameters(this.zoom), evaluationFeature, canonical)) continue;

            const bucketFeature: BucketFeature = {
                id,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature, canonical, tileTransform),
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            const modelId = this.addFeature(bucketFeature, bucketFeature.geometry, evaluationFeature);

            if (modelId) {
                options.featureIndex.insert(feature, bucketFeature.geometry, index, sourceLayerIndex, this.index, this.instancesPerModel[modelId].instancedDataArray.length);
            }
        }
    }

    // eslint-disable-next-line no-unused-vars
    update(states: FeatureStates, vtLayer: IVectorTileLayer, availableImages: Array<string>, imagePositions: SpritePositions) {
        // called when setFeature state API is used
        for (const modelId in this.instancesPerModel) {
            const instances = this.instancesPerModel[modelId];
            for (const id in states) {
                if (instances.idToFeaturesIndex.hasOwnProperty(id)) {
                    const feature = instances.features[instances.idToFeaturesIndex[id]];
                    this.evaluate(feature, states[id], instances, true);
                }
            }
        }
    }

    isEmpty(): boolean {
        for (const modelId in this.instancesPerModel) {
            const perModelAttributes = this.instancesPerModel[modelId];
            if (perModelAttributes.instancedDataArray.length !== 0) return false;
        }
        return true;
    }

    uploadPending(): boolean {
        return !this.uploaded;
    }

    upload(context: Context) {
        // if buffer size is less than the threshold, do not upload instance buffer.
        // if instance buffer is not uploaded, instances are rendered one by one.
        const useInstancingThreshold = Number.MAX_SAFE_INTEGER;
        if (!this.uploaded) {
            for (const modelId in this.instancesPerModel) {
                const perModelAttributes = this.instancesPerModel[modelId];
                if (perModelAttributes.instancedDataArray.length < useInstancingThreshold || perModelAttributes.instancedDataArray.length === 0) continue;
                if (!perModelAttributes.instancedDataBuffer) {
                    perModelAttributes.instancedDataBuffer = context.createVertexBuffer(perModelAttributes.instancedDataArray, perModelAttributes.instancedDataArray.members, true);
                } else {
                    perModelAttributes.instancedDataBuffer.updateData(perModelAttributes.instancedDataArray);
                }
            }
        }
        this.uploaded = true;
    }

    destroy() {
        for (const modelId in this.instancesPerModel) {
            const perModelAttributes = this.instancesPerModel[modelId];
            if (perModelAttributes.instancedDataArray.length === 0) continue;
            if (perModelAttributes.instancedDataBuffer) {
                perModelAttributes.instancedDataBuffer.destroy();
            }
        }
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, evaluationFeature: EvaluationFeature): string {
        const layer = this.layers[0];
        const modelIdProperty = layer.layout.get('model-id');
        assert(modelIdProperty);
        const modelId = modelIdProperty.evaluate(evaluationFeature, {}, this.canonical);
        if (!modelId) {
            warnOnce(`modelId is not evaluated for layer ${layer.id} and it is not going to get rendered.`);
            return modelId;
        }
        if (!this.instancesPerModel[modelId]) {
            this.instancesPerModel[modelId] = new PerModelAttributes();
        }
        const perModelVertexArray = this.instancesPerModel[modelId];
        const instancedDataArray = perModelVertexArray.instancedDataArray;

        const modelFeature = new ModelFeature(evaluationFeature, instancedDataArray.length);
        for (const geometries of geometry) {
            for (const point of geometries) {
                if (point.x < 0 || point.x >= EXTENT || point.y < 0 || point.y >= EXTENT) {
                    continue; // Clip on tile borders to prevent duplicates
                }
                const i = instancedDataArray.length;
                instancedDataArray.resize(i + 1);
                perModelVertexArray.instancesEvaluatedElevation.push(0);
                instancedDataArray.float32[i * 16] = point.x;
                instancedDataArray.float32[i * 16 + 1] = point.y;
            }
        }
        modelFeature.instancedDataCount = perModelVertexArray.instancedDataArray.length - modelFeature.instancedDataOffset;
        if (modelFeature.instancedDataCount > 0) {
            if (feature.id) {
                perModelVertexArray.idToFeaturesIndex[feature.id] = perModelVertexArray.features.length;
            }
            perModelVertexArray.features.push(modelFeature);
            this.evaluate(modelFeature, {}, perModelVertexArray, false);
        }
        return modelId;
    }

    evaluate(feature: ModelFeature, featureState: FeatureStates, perModelVertexArray: PerModelAttributes, update: boolean) {
        const layer = this.layers[0];
        const evaluationFeature = feature.feature;
        const canonical = this.canonical;
        const rotation = layer.paint.get('model-rotation').evaluate(evaluationFeature, featureState, canonical);
        const scale = layer.paint.get('model-scale').evaluate(evaluationFeature, featureState, canonical);
        const translation = layer.paint.get('model-translation').evaluate(evaluationFeature, featureState, canonical);
        const color = layer.paint.get('model-color').evaluate(evaluationFeature, featureState, canonical);
        color.a = layer.paint.get('model-color-mix-intensity').evaluate(evaluationFeature, featureState, canonical);
        const rotationScaleYZFlip: Mat4 = [];

        rotationScaleYZFlipMatrix(rotationScaleYZFlip, (rotation: any), (scale: any));

        // https://github.com/mapbox/mapbox-gl-native-internal/blob/c380f9492220906accbdca1f02cca5ee489d97fc/src/mbgl/renderer/layers/render_model_layer.cpp#L1282
        const constantTileToMeterAcrossTile = 10;
        assert(perModelVertexArray.instancedDataArray.bytesPerElement === 64);

        const vaOffset2 = Math.round(100.0 * color.a) + color.b / 1.05;

        for (let i = 0; i < feature.instancedDataCount; ++i) {
            const instanceOffset = feature.instancedDataOffset + i;
            const offset = instanceOffset * 16;

            const va = perModelVertexArray.instancedDataArray.float32;
            let terrainElevationContribution = 0;
            if (update) {
                terrainElevationContribution = va[offset + 6] - perModelVertexArray.instancesEvaluatedElevation[instanceOffset];
            }

            // All per-instance attributes are packed to one 4x4 float matrix. Data is not expected
            // to change on every frame when e.g. camera or light changes.
            // Column major order. Elements:
            // 0 & 1: tile coordinates stored in integer part of float, R and G color components,
            // originally in range [0..1], scaled to range [0..0.952(arbitrary, just needs to be
            // under 1)].
            const pointY = va[offset + 1] | 0; // point.y stored in integer part
            va[offset]      = (va[offset] | 0) + color.r / 1.05; // point.x stored in integer part
            va[offset + 1]  = pointY + color.g / 1.05;
            // Element 2: packs color's alpha (as integer part) and blue component in fractional part.
            va[offset + 2]  = vaOffset2;
            // tileToMeter is taken at center of tile. Prevent recalculating it over again for
            // thousands of trees.
            // Element 3: tileUnitsToMeter conversion.
            va[offset + 3]  = 1.0 / (canonical.z > constantTileToMeterAcrossTile ? this.tileToMeter : tileToMeter(canonical, pointY));
            // Elements [4..6]: translation evaluated for the feature.
            va[offset + 4]  = translation[0];
            va[offset + 5]  = translation[1];
            va[offset + 6]  = translation[2] + terrainElevationContribution;
            // Elements [7..16] Instance modelMatrix holds combined rotation and scale 3x3,
            va[offset + 7]  = rotationScaleYZFlip[0];
            va[offset + 8]  = rotationScaleYZFlip[1];
            va[offset + 9]  = rotationScaleYZFlip[2];
            va[offset + 10] = rotationScaleYZFlip[4];
            va[offset + 11] = rotationScaleYZFlip[5];
            va[offset + 12] = rotationScaleYZFlip[6];
            va[offset + 13] = rotationScaleYZFlip[8];
            va[offset + 14] = rotationScaleYZFlip[9];
            va[offset + 15] = rotationScaleYZFlip[10];
            perModelVertexArray.instancesEvaluatedElevation[instanceOffset] = translation[2];
        }
    }
}

register(ModelBucket, 'ModelBucket', {omit: ['layers']});
register(PerModelAttributes, 'PerModelAttributes');
register(ModelFeature, 'ModelFeature');

export default ModelBucket;