const INT_EXT_LABEL: Record<string, string> = {
  INT: "INT.",
  EXT: "EXT.",
  INT_EXT: "INT./EXT.",
};

export function formatSlugline(intExt: string, location: string, timeOfDay: string): string {
  return `${INT_EXT_LABEL[intExt] ?? intExt} ${location.toUpperCase()} — ${timeOfDay}`;
}
