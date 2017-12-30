import RESOURCE_TYPES from 'common/RESOURCE_TYPES';
import Combatants from 'Parser/Core/Modules/Combatants';

import ResourceTracker from '../ResourceTracker/ResourceTracker';

class EnergyTracker extends ResourceTracker {
  static dependencies = {
    combatants: Combatants,
  };

  on_initialized() {
    this.resourceType = RESOURCE_TYPES.ENERGY;
    this.resourceName = 'Energy';
  }
}

export default EnergyTracker;