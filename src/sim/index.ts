/** Public API of the simulation layer (Layer 1). */
export { SimEngine, PEAK_LOAD_FACTOR, type EngineOptions } from './engine';
export { generateCity, districtOf, cityInfo } from './cityGen';
export { buildNetwork, computeIslands, buildingCentre, nodeIdOf, TRANSMISSION_CAPACITY_KW, type Island } from './powerNetwork';
export { BaselinePolicy, BaselineValidator } from './policy';
export { SCENARIOS, getScenario, type Scenario, type ScenarioEvent } from './scenarios';
export type { SimDisasterParams } from './disasters';
export { KIND_PROFILES } from './profiles';
export { hourOf } from './telemetry';
export { MicrogridTopology, daylight, EXPORT_MARGIN } from './microgrid';
export { buildWaterNetwork, updateWaterNetwork, waterSourceId, waterConsumerId } from './waterNetwork';
