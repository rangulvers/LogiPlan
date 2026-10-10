// The six ladder examples, appended after the five original ones in js/model/examples.js (docs/EXAMPLES-DESIGN.md 2, 9.1). Each module exports
// `meta` (id, name, level, rank, description, learn, chips, notes, tips) and `build()`; the entries here are `{ ...meta, build }` in ladder order.
import * as helloPallet from './hello-pallet.js';
import * as chargingCorner from './charging-corner.js';
import * as yardShuttle from './yard-shuttle.js';
import * as morningPeak from './morning-peak.js';
import * as componentsPlant from './components-plant.js';
import * as twinPlants from './twin-plants.js';

export const NEW_EXAMPLES = [helloPallet, chargingCorner, yardShuttle, morningPeak, componentsPlant, twinPlants].map((m) => ({ ...m.meta, build: m.build }));
