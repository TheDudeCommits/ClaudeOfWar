import * as THREE from 'three';

/**
 * Crowd director — the attack-token pattern.
 *
 * Left alone, every enemy closes to its own attack range and swings whenever
 * its private cooldown fires. The result is an unreadable scrum where the
 * player takes damage from off-screen and cannot plan. Every good action-game
 * crowd fight solves this the same way: a small number of *tokens* grant the
 * right to attack, everyone else is required to hold a ring and circle.
 *
 * That single rule is what makes a pack read as choreography rather than as
 * noise, and it is what makes parry and dodge learnable — the player only ever
 * has to track one or two committed attackers at a time.
 */

const _v = new THREE.Vector3();

export class CombatDirector {
  constructor(opts = {}) {
    this.maxAttackers = opts.maxAttackers ?? 2;
    // Measured median enemy-to-player distance was 1.42m with p10 at 0.87m —
    // body contact, not tactical spacing. Two of four draugr were permanently
    // pressed against the hero.
    this.ringMin = opts.ringMin ?? 3.6;
    this.ringMax = opts.ringMax ?? 5.6;
    // Stagger so two token-holders never land a blow on the same frame; the
    // player needs a readable gap to react in.
    this.minSpacing = opts.minSpacing ?? 0.55;
    this._tokens = new Set();
    this._lastGrant = -99;
    this._lastSwing = -99;
    this.time = 0;
  }

  /** Called once per frame before enemies update. */
  update(dt, player, enemies) {
    this.time += dt;

    // Release tokens from anyone dead, staggered, or no longer in range.
    for (const e of Array.from(this._tokens)) {
      const gone = e.dead || e.stagger > 0 ||
        e.root.position.distanceTo(player.root.position) > 6.0;
      if (gone || e._tokenDone) {
        this._tokens.delete(e);
        e.hasToken = false;
        e._tokenDone = false;
      }
    }

    // Grant to the closest eligible candidates, respecting the spacing gap.
    if (this._tokens.size < this.maxAttackers &&
        this.time - this._lastGrant >= this.minSpacing) {
      let best = null, bestD = Infinity;
      for (const e of enemies) {
        if (e.dead || e.hasToken || e.stagger > 0) continue;
        const d = e.root.position.distanceTo(player.root.position);
        if (d > 5.5) continue;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) {
        this._tokens.add(best);
        best.hasToken = true;
        best._tokenDone = false;
        this._lastGrant = this.time;
      }
    }

    // Assign each non-attacker a slot on the ring so they spread around the
    // player instead of clumping on the side they happened to arrive from.
    // Slot count is taken from the LIVING population, not the idle subset:
    // using the idle count made every ring angle jump each time a token
    // changed hands.
    const alive = enemies.filter((e) => !e.dead);
    const n = Math.max(1, alive.length);
    alive.forEach((e, i) => { if (e._slot === undefined) e._slot = i; });
    const idle = alive.filter((e) => !e.hasToken);
    idle.forEach((e) => {
      // Slowly rotate the ring so a held position still feels alive.
      const ang = (e._slot / n) * Math.PI * 2 + this.time * 0.22;
      const r = this.ringMin + (this.ringMax - this.ringMin) * ((e._slot % 3) / 2);
      e.ringTarget = _v.set(
        player.root.position.x + Math.cos(ang) * r,
        0,
        player.root.position.z + Math.sin(ang) * r).clone();
    });
  }

  /**
   * Gate the SWING, not the token grant.
   *
   * Spacing the grants does not space the blows: each holder then swings on its
   * own randomised cooldown, and two landed simultaneously in 5.6% of frames.
   * The player needs a guaranteed readable gap between incoming attacks, so
   * every swing has to ask permission at the moment it fires.
   */
  requestSwing() {
    if (this.time - this._lastSwing < this.minSpacing) return false;
    this._lastSwing = this.time;
    return true;
  }

  release(enemy) {
    enemy._tokenDone = true;
  }
}
