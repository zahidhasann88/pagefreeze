export interface Clock {
  now(): Date;
  /** Milliseconds since the epoch. */
  timestamp(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  timestamp: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export class FakeClock implements Clock {
  private current: number;
  readonly sleeps: number[] = [];

  constructor(start: Date | number | string = new Date('2026-01-01T00:00:00Z')) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  timestamp(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(value: Date | number | string): void {
    this.current = new Date(value).getTime();
  }
}
