export type Migration = {
  readonly version: number;
  readonly statements: readonly string[];
};

