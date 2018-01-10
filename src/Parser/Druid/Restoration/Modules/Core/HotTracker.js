import SPELLS from 'common/SPELLS';
import ITEMS from 'common/ITEMS';
import Analyzer from 'Parser/Core/Analyzer';
import Combatants from 'Parser/Core/Modules/Combatants';
import calculateEffectiveHealing from 'Parser/Core/calculateEffectiveHealing';
import Mastery from './Mastery';

const BUFFER_MS = 150; // saw a few cases of taking close to 150ms from cast -> applybuff
const PANDEMIC_FACTOR = 1.3;

const debug = false;

/*
 * Backend module for tracking attribution of HoTs, e.g. what applied them / applied parts of them / boosted them
 */
class HotTracker extends Analyzer {
  static dependencies = {
    combatants: Combatants,
    mastery: Mastery,
  };

  // objects hold attribution running totals
  powerOfTheArchdruid = {
    rejuvenation: { healing: 0, masteryHealing: 0, procs: 0 },
    regrowth: { healing: 0, masteryHealing: 0, procs: 0 },
  };
  tearstoneOfElune = { healing: 0, masteryHealing: 0, procs: 0 };
  t194p = { healing: 0, masteryHealing: 0, procs: 0 };
  t214p = { healing: 0, masteryHealing: 0, procs: 0 }; // used to distinguish Dreamer procs that would not have happened but for the 4pc
  t212p = { healing: 0, masteryHealing: 0, procs: 0 }; // for all the Dreamer procs except those attributable to 4pc

  // {
  //   [playerId]: {
  //      [hotId]: { applied, attributions, ... },
  //   },
  // }
  hots = {};

  // cast tracking stuff
  lastRejuvCastTimestamp;
  lastRejuvTarget;
  lastRegrowthCastTimestamp;
  lastRegrowthTarget;
  lastWildGrowthCastTimestamp

  // PotA tracking stuff
  lastPotaRejuvTimestamp;
  lastPotaRegrowthTimestamp;
  potaFallTimestamp; // FIXME temp until figure out hasBuff problem
  potaTarget;

  // Tearstone tracking stuff
  lastWildgrowthTimestamp;
  hasTearstone;

  // 4T19 tracking stuff
  has4t19;

  // 4T21 tracking stuff
  remaining4t21attributes = 0;

  on_initialized() {
    this.hasTearstone = this.combatants.selected.hasFinger(ITEMS.TEARSTONE_OF_ELUNE.id);
    this.has4t19 = this.combatants.selected.hasBuff(SPELLS.RESTO_DRUID_T19_4SET_BONUS_BUFF.id);
    this.hotInfo = this._generateHotInfo(); // some HoT info depends on traits and so must be generated dynamically
  }

  on_byPlayer_cast(event) {
    const spellId = event.ability.guid;
    const targetId = event.targetID;

    // set last cast timestamps, used for attribution of HoT applications later
    if (spellId === SPELLS.REJUVENATION.id) {
      this.lastRejuvCastTimestamp = event.timestamp;
      this.lastRejuvTarget = targetId;
    } else if (spellId === SPELLS.REGROWTH.id) {
      this.lastRegrowthCastTimestamp = event.timestamp;
      this.lastRegrowthTarget = targetId;
    } else if (spellId === SPELLS.WILD_GROWTH.id) {
      this.lastWildGrowthCastTimestamp = event.timestamp;
    }

    // check for PotA proc
    //const hadPota = this.combatants.selected.hasBuff(SPELLS.POWER_OF_THE_ARCHDRUID_BUFF, null, BUFFER_MS);
    const hadPota = this.potaFallTimestamp && this.potaFallTimestamp + BUFFER_MS > event.timestamp;
    if (spellId === SPELLS.REJUVENATION.id && hadPota) {
      this.lastPotaRejuvTimestamp = event.timestamp;
      this.potaTarget = targetId;
    } else if (spellId === SPELLS.REGROWTH.id && hadPota) {
      this.lastPotaRegrowthTimestamp = event.timestamp;
      this.potaTarget = targetId;
    }
  }

  on_byPlayer_heal(event) {
    const spellId = event.ability.guid;

    // TODO attribute Dreamwalker...

    const target = this._validateAndGetTarget(event);
    if (!target) {
      return;
    }
    const targetId = event.targetID;
    const hot = this.hots[targetId][spellId];

    const healing = event.amount + (event.absorbed || 0);
    if (event.tick) { // direct healing (say from a PotA procced regrowth) still should be counted for attribution, but not part of tick tracking
      hot.ticks.push({ healing, timestamp: event.timestamp });
    }

    hot.attributions.forEach(att => att.healing += healing);
    hot.boosts.forEach(att => att.healing += calculateEffectiveHealing(event, att.boost));

    // TODO add handling for HoT extensions

    // attribute mastery boosting as well to all the other HoTs on the heal's target
    const oneStack = this.mastery.decomposeHeal(event).oneStack;
    Object.keys(this.hots[targetId]).forEach(otherSpellId => {
      if (otherSpellId !== spellId) {
        const otherHot = this.hots[targetId][otherSpellId];
        otherHot.attributions.forEach(att => att.masteryHealing += oneStack);
        // boosts don't get mastery benefit because the hot was there with or without the boost
        // TODO add handling for HoT extensions
      }
    });
  }

  on_byPlayer_applybuff(event) {
    if (event.ability.guid === SPELLS.AWAKENED.id) {
      // 4t21 proc causes 5 dreamer procs that would not otherwise have happened
      // while in reality there is usually a quick sequence of 6 dreamers, one of which is "natural",
      // we simplify by attributing the next 5 to 4t21
      this.remaining4t21attributes = 5;
    }

    const spellId = event.ability.guid;
    const target = this._validateAndGetTarget(event);
    if (!target) {
      return;
    }
    const targetId = event.targetID;

    const newHot = {
      start: event.timestamp,
      end: event.timestamp + this.hotInfo[spellId].duration,
      ticks: [], // listing of ticks w/ effective heal amount and timestamp, to be used as part of the HoT extension calculations
      attributions: [], // The effect or bonus that procced this HoT application. No attribution implies the spell was hardcast.
      extensions: [], // The effects or bonuses that caused this HoT to have extended duration. TODO NYI
      boosts: [], // The effects or bonuses that caused the strength of this HoT to be boosted for its full duration.
    };
    if(!this.hots[targetId]) {
      this.hots[targetId] = {};
    }
    this.hots[targetId][spellId] = newHot;

    newHot.attributions = this._getAttributions(spellId, targetId, event.timestamp, event);
  }

  on_byPlayer_refreshbuff(event) {
    const spellId = event.ability.guid;
    const target = this._validateAndGetTarget(event);
    if (!target) {
      return;
    }
    const targetId = event.targetID;

    const hot = this.hots[targetId][spellId];
    const oldEnd = hot.end;

    // TODO check / build suggestion for early refreshes, etc

    const newEndMax = oldEnd + this.hotInfo[spellId].duration;
    const pandemicMax = event.timestamp + (this.hotInfo[spellId].duration * PANDEMIC_FACTOR);
    hot.end = Math.min(newEndMax, pandemicMax);

    hot.attributions = this._getAttributions(spellId, targetId, event.timestamp, event); // new attributions on refresh
    // TODO add handling for HoT extensions... how should extensions be handled in the case of an early refresh?
    hot.boosts = [];
  }

  on_byPlayer_removebuff(event) {
    if(event.ability.guid === SPELLS.POWER_OF_THE_ARCHDRUID_BUFF.id) {
      this.potaFallTimestamp = event.timestamp; // FIXME temp until figure out hasBuff problem
    }

    const spellId = event.ability.guid;
    const target = this._validateAndGetTarget(event);
    if (!target) {
      return;
    }
    const targetId = event.targetID;

    // TODO here's where HoT extensions will actually be tallied
    // TODO check how well actual HoT remove time matched with the expected HoT remove time

    delete this.hots[targetId][spellId];
  }

  // validates an event and gets its target ... returns null if for any reason the event should not be further processed
  _validateAndGetTarget(event) {
    const spellId = event.ability.guid;
    if (!(spellId in this.hotInfo)) {
      return null; // we only care about the listed HoTs
    }

    const target = this.combatants.getEntity(event);
    if (!target) {
      return null; // target wasn't important (a pet probably)
    }

    const targetId = event.targetID;
    if (!targetId) {
      debug && console.log(`${event.ability.name} ${event.type} to target without ID @${this.owner.formatTimestamp(event.timestamp)}... HoT will not be tracked.`);
      return null;
    } else {
      debug && console.log(`${event.ability.name} ${event.type} to ID ${targetId} @${this.owner.formatTimestamp(event.timestamp)}`);
    }

    if (['removebuff', 'refreshbuff', 'heal'].includes(event.type) &&
       (!this.hots[targetId] || !this.hots[targetId][spellId])) {
      console.warn(`${event.ability.name} ${event.type} on target ID ${targetId} @${this.owner.formatTimestamp(event.timestamp)} but there's no record of the HoT being added...`);
      return null;
    }

    return target;
  }

  _getAttributions(spellId, targetId, timestamp, event) {
    const attributions = [];
    let attName = "NONE";
    if (spellId === SPELLS.REJUVENATION.id || spellId === SPELLS.REJUVENATION_GERMINATION.id) {
      if (event.prepull || (this.lastRejuvCastTimestamp + BUFFER_MS > timestamp && this.lastRejuvTarget === targetId)) { // regular cast (assume prepull applications are hardcast)
        // standard hardcast gets no special attribution
        attName = "Hardcast";
      } else if (this.lastPotaRejuvTimestamp + BUFFER_MS > timestamp && this.potaTarget !== targetId) { // PotA proc but not primary target
        attributions.push(this.powerOfTheArchdruid.rejuvenation);
        attName = "Power of the Archdruid";
      } else if (this.hasTearstone && this.lastWildGrowthCastTimestamp + BUFFER_MS > timestamp) {
        attributions.push(this.tearstoneOfElune);
        attName = "Tearstone of Elune";
      } else if (this.has4t19) {
        attributions.push(this.t194p);
        attName = "Tier19 4pc";
      } else {
        console.warn(`Unable to attribute Rejuv @${this.owner.formatTimestamp(timestamp)} on ${targetId}`);
      }

    } else if (spellId === SPELLS.REGROWTH.id) {
      if (event.prepull || (this.lastRegrowthCastTimestamp + BUFFER_MS > timestamp && this.lastRegrowthTarget === targetId)) { // regular cast (assume prepull applications are hardcast)
        // standard hardcast gets no special attribution
        attName = "Hardcast";
      } else if (this.lastPotalRegrowthTimestamp + BUFFER_MS > timestamp && this.potaTarget !== targetId) { // PotA proc but not primary target
        attributions.push(this.powerOfTheArchdruid.regrowth);
        attName = "Power of the Archdruid";
      } else {
        console.warn(`Unable to attribute Regrowth @${this.owner.formatTimestamp(timestamp)} on ${targetId}`);
      }

    } else if (spellId === SPELLS.DREAMER.id) {
      if(this.remaining4t21attributes > 0) {
        attributions.push(this.t214p);
        this.remaining4t21attributes -= 1;
        attName = "Tier21 4pc";
      } else {
        attributions.push(this.t212p);
        attName = "Tier21 2pc";
      }

    } else {
      // ...
    }

    debug && this._logAttribution(spellId, targetId, timestamp, attName);

    attributions.forEach(att => att.procs += 1);
    return attributions;
  }

  _logAttribution(spellId, targetId, timestamp, attName) {
    console.log(`${spellId} on ${targetId} @${this.owner.formatTimestamp(timestamp)} attributed to ${attName}`);
  }

  _generateHotInfo() { // must be generated dynamically because it reads from traits
    return {
      [SPELLS.REJUVENATION.id]: {
        duration: 15000 + (1000 * this.combatants.selected.traitsBySpellId[SPELLS.PERSISTENCE_TRAIT.id]),
        tickPeriod: 3000,
      },
      [SPELLS.REJUVENATION_GERMINATION.id]: {
        duration: 15000 + (1000 * this.combatants.selected.traitsBySpellId[SPELLS.PERSISTENCE_TRAIT.id]),
        tickPeriod: 3000,
      },
      [SPELLS.REGROWTH.id]: {
        duration: 12000,
        tickPeriod: 2000,
      },
      [SPELLS.WILD_GROWTH.id]: {
        duration: 7000,
        tickPeriod: 1000,
      },
      [SPELLS.LIFEBLOOM_HOT_HEAL.id]: {
        duration: 15000,
        tickPeriod: 1000,
      },
      [SPELLS.CENARION_WARD.id]: {
        duration: 8000,
        tickPeriod: 2000,
      },
      [SPELLS.CULTIVATION.id]: {
        duration: 6000,
        tickPeriod: 2000,
      },
      [SPELLS.SPRING_BLOSSOMS.id]: {
        duration: 6000,
        tickPeriod: 2000,
      },
      [SPELLS.DREAMER.id]: {
        duration: 8000,
        tickPeriod: 2000,
      },
    };
  }
}

export default HotTracker;
