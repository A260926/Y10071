export interface Clock {
  now(): Date;
}

export const clock: Clock = {
  now: () => new Date(),
};

export function setClock(next: () => Date): void {
  clock.now = next;
}

export function resetClock(): void {
  clock.now = () => new Date();
}
