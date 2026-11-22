const rectangle = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'integer', minimum: 0 },
    y: { type: 'integer', minimum: 0 },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  },
} as const

export const visualExclusionsInputSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Visual-only exclusions, at most 20 rectangles and 20% union coverage per viewport. Rectangles must fit the viewport; overlap counts once. Omitted and empty regions are equivalent.',
  properties: {
    phonePortrait: { type: 'array', maxItems: 20, items: rectangle },
    phoneLandscape: { type: 'array', maxItems: 20, items: rectangle },
    desktop: { type: 'array', maxItems: 20, items: rectangle },
  },
} as const

export const visualComparisonSchema = {
  type: 'object',
  properties: {
    viewport: { type: 'string', enum: ['phonePortrait', 'phoneLandscape', 'desktop'] },
    changedPixels: { type: 'integer', description: 'Detected changed pixels outside exclusions.' },
    changedPercent: {
      type: 'number',
      description: 'Changed pixels divided by included pixels, times 100.',
    },
    rawChangedPixels: {
      type: 'integer',
      description: 'Detected changes before exclusions, when exclusions were applied.',
    },
    rawChangedPercent: { type: 'number' },
    exclusions: { type: 'array', maxItems: 20, items: rectangle },
    excludedPixels: { type: 'integer' },
    includedPixels: { type: 'integer' },
    diffImageUrl: { type: 'string' },
    baselineScreenshotSha256: { type: 'string' },
    currentScreenshotSha256: { type: 'string' },
  },
} as const
