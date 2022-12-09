import { formatDurationMinSec } from 'common/format';
import SPELLS from 'common/SPELLS';
import talents from 'common/TALENTS/monk';
import MAGIC_SCHOOLS, { color } from 'game/MAGIC_SCHOOLS';
import { SpellLink } from 'interface';
import { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import EventFilter from 'parser/core/EventFilter';
import Events, {
  AddStaggerEvent,
  DamageEvent,
  EventType,
  RemoveStaggerEvent,
} from 'parser/core/Events';
import { ReactNode } from 'react';
import CountsAsBrew, { brewCooldownDisplay } from '../../components/CountsAsBrew';
import { absoluteMitigation, MajorDefensive, Mitigation, MitigationSegment } from './core';

export class FortifyingBrew extends MajorDefensive {
  private fortBrewStaggerPool: number = 0;
  private hasGaiPlins = false;

  constructor(options: Options) {
    super(
      { talent: talents.FORTIFYING_BREW_TALENT, buffSpell: SPELLS.FORTIFYING_BREW_BRM_BUFF },
      options,
    );

    this.addEventListener(Events.damage.to(SELECTED_PLAYER), this.recordDamage);

    if (this.selectedCombatant.hasTalent(talents.FORTIFYING_BREW_DETERMINATION_TALENT)) {
      this.addEventListener(new EventFilter(EventType.AddStagger), this.recordStagger);
      this.addEventListener(new EventFilter(EventType.RemoveStagger), this.recordPurify);

      this.hasGaiPlins = this.selectedCombatant.hasTalent(talents.GAI_PLINS_IMPERIAL_BREW_TALENT);
    }
  }

  private recordDamage(event: DamageEvent) {
    if (this.defensiveActive && !event.sourceIsFriendly) {
      this.recordMitigation({
        event,
        mitigatedAmount: absoluteMitigation(event, 0.2),
      });
    }
  }

  private recordStagger(event: AddStaggerEvent) {
    if (this.defensiveActive) {
      this.fortBrewStaggerPool += 0.15 * event.amount;
    }
  }

  private recordPurify(event: RemoveStaggerEvent) {
    // we don't use a fixed 50% for this because it could be mitigated by
    // Staggering Strikes or one of the other related talents.
    //
    // we also use "fair" assignment of value to Determination: when you purify
    // X% damage, we remove X% from the fort brew and non-fort brew pools. this
    // means that if you Stagger 3k extra damage, hitting Staggering Strikes
    // doesn't give 100% of that value to Determination.
    const purifyRatio = event.amount / (event.amount + event.newPooledDamage);
    const purifyAmount = Math.ceil(purifyRatio * this.fortBrewStaggerPool);

    if (this.defensiveActive && event.trigger?.ability.guid !== SPELLS.STAGGER_TAKEN.id) {
      this.recordMitigation({
        event,
        mitigatedAmount: purifyAmount * (this.hasGaiPlins ? 1.25 : 1),
      });
    }

    this.fortBrewStaggerPool = Math.max(0, this.fortBrewStaggerPool - purifyAmount);
  }

  description(): ReactNode {
    return (
      <>
        <p>
          <SpellLink id={talents.FORTIFYING_BREW_TALENT} /> is a flexible cooldown that combines
          with several talents for boosting its defensive power or reducing its cooldown.{' '}
          <CountsAsBrew baseCooldown={60 * 6} />
          <br />
          <small>
            Reduced to {formatDurationMinSec(brewCooldownDisplay(4 * 60))} with{' '}
            <SpellLink id={talents.EXPEDITIOUS_FORTIFICATION_TALENT} />.
          </small>
        </p>
        <p>
          Its variable, medium-long cooldown makes it hard to plan usage times in advance, so it is
          a good choice for a reactive cooldown if your other cooldowns can cover major damage.
        </p>
        <p>
          <small>
            <strong>Note:</strong> Calculating mitigation from{' '}
            <SpellLink id={talents.IRONSHELL_BREW_TALENT} /> is not yet supported.
          </small>
        </p>
      </>
    );
  }

  mitigationSegments(mit: Mitigation): MitigationSegment[] {
    const damage = mit.mitigated
      .filter((event) => event.event.type === EventType.Damage)
      .map((event) => event.mitigatedAmount)
      .reduce((a, b) => a + b, 0);

    const purifyBase = mit.mitigated
      .filter((event) => event.event.type === EventType.RemoveStagger)
      .map((event) => event.mitigatedAmount)
      .reduce((a, b) => a + b, 0);

    let purify = purifyBase;
    let gaiPlins = 0;
    if (this.hasGaiPlins) {
      purify = purifyBase / 1.25;
      gaiPlins = purifyBase - purify;
    }

    return [
      {
        amount: damage,
        color: color(MAGIC_SCHOOLS.ids.PHYSICAL),
        tooltip: (
          <>
            Base <SpellLink id={talents.FORTIFYING_BREW_TALENT} />
          </>
        ),
      },
      {
        amount: purify,
        color: 'rgb(112, 181, 112)',
        tooltip: <SpellLink id={talents.FORTIFYING_BREW_DETERMINATION_TALENT} />,
      },
      {
        amount: gaiPlins,
        color: color(MAGIC_SCHOOLS.ids.HOLY),
        tooltip: <SpellLink id={talents.GAI_PLINS_IMPERIAL_BREW_TALENT} />,
      },
    ].filter((seg) => seg.amount > 0);
  }
}
