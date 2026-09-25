/**
 * All money is stored/passed internally as integer minor units ("kobo"),
 * e.g. NGN 1,500.50 === 150050. This module is the only place that converts
 * to/from the major-unit decimal representation used in API responses, so
 * rounding behaviour is centralised and consistent.
 */

export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100);
}

export function koboToNaira(kobo: number): number {
  return Math.round(kobo) / 100;
}

export function formatKoboAsNaira(kobo: number): string {
  return koboToNaira(kobo).toFixed(2);
}
