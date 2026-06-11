import { describe, expect, it } from 'vitest';
import { buildTurntableLayout } from './turntable.js';

describe('rotating deck rail — at(d) follows the live deck angle', () => {
  it('at θ=0 the deck is horizontal: centre at the deck centre, heading east', () => {
    const layout = buildTurntableLayout();
    const deck = layout.net.railOf(layout.deck);
    layout.deckAngle.deg = 0;
    const mid = deck.at(layout.deckLength / 2);
    expect(mid.x).toBeCloseTo(layout.deckCentre.x, 6);
    expect(mid.y).toBeCloseTo(layout.deckCentre.y, 6);
    expect(mid.headingDeg).toBeCloseTo(0, 6);
    /* The west rim (d=0) is one radius WEST of the centre. */
    const west = deck.at(0);
    expect(west.x).toBeCloseTo(layout.deckCentre.x - layout.deckRadius, 6);
    expect(west.y).toBeCloseTo(layout.deckCentre.y, 6);
  });

  it('a body parked at the deck centre stays put as the deck swings — only heading turns', () => {
    const layout = buildTurntableLayout();
    const deck = layout.net.railOf(layout.deck);
    const centreD = layout.deckLength / 2;
    for (const θ of [0, 45, 90, 135, 180, 270]) {
      layout.deckAngle.deg = θ;
      const p = deck.at(centreD);
      expect(p.x).toBeCloseTo(layout.deckCentre.x, 6);
      expect(p.y).toBeCloseTo(layout.deckCentre.y, 6);
      expect(p.headingDeg).toBeCloseTo(θ, 6);
    }
  });

  it('at θ=90 the deck is vertical: the far end is one radius SOUTH (screen +y), heading 90', () => {
    const layout = buildTurntableLayout();
    const deck = layout.net.railOf(layout.deck);
    layout.deckAngle.deg = 90;
    const end = deck.at(layout.deckLength);
    expect(end.x).toBeCloseTo(layout.deckCentre.x, 6);
    expect(end.y).toBeCloseTo(layout.deckCentre.y + layout.deckRadius, 6);
    expect(end.headingDeg).toBeCloseTo(90, 6);
  });

  it('at θ=180 the deck far end points WEST — the half-turn carries a body round', () => {
    const layout = buildTurntableLayout();
    const deck = layout.net.railOf(layout.deck);
    layout.deckAngle.deg = 180;
    const end = deck.at(layout.deckLength);
    /* The far end, east at θ=0, is now one radius WEST of centre. */
    expect(end.x).toBeCloseTo(layout.deckCentre.x - layout.deckRadius, 6);
    expect(end.y).toBeCloseTo(layout.deckCentre.y, 6);
    expect(end.headingDeg).toBeCloseTo(180, 6);
  });

  it('the deck has zero curvature and slope (a flat, straight span however it points)', () => {
    const layout = buildTurntableLayout();
    const deck = layout.net.railOf(layout.deck);
    layout.deckAngle.deg = 73;
    expect(deck.curvatureAt(layout.deckLength / 2)).toBe(0);
    expect(deck.slopeAt(layout.deckLength / 2)).toBe(0);
  });

  it('the turn-around stub is the WESTBOUND one, with no flipsFacing (the deck does the turn)', () => {
    const layout = buildTurntableLayout();
    const turn = layout.stubs.find((s) => s.position === 'stub-w');
    expect(turn).toBeDefined();
    expect(turn?.angleDeg).toBe(180);
    /* The 180° is physical (the rotating deck), so no rail-direction flip. */
    expect(turn?.flipsFacing).toBe(false);
  });
});
