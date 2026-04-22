import { AGE_MODIFIERS } from "./constants";
import type { Position } from "./types";

export function ageModifier(position: Position, age: number): number {
  const curve = AGE_MODIFIERS[position];
  const ages = Object.keys(curve)
    .map(Number)
    .sort((a, b) => a - b);

  const minAge = ages[0];
  const maxAge = ages[ages.length - 1];

  if (age <= minAge) return curve[minAge];
  if (age >= maxAge) return curve[maxAge];

  const floor = Math.floor(age);
  const ceil = Math.ceil(age);
  if (floor === ceil) return curve[floor];

  const t = age - floor;
  return curve[floor] * (1 - t) + curve[ceil] * t;
}
