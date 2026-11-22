import type { Page } from 'playwright'
import type { PerformanceEvidence } from '../types.js'
import { withTimeout } from './timeout.js'

export interface LargestResourceEvidence {
  index: number
  origin: string
  type: string
  transferredBytes: number
  encodedBodyBytes: number
  durationMs?: number
  sizeObservation: 'measured' | 'unavailable_or_cached'
}

export interface ResourceDetails {
  observation: 'measured' | 'unavailable'
  largest: LargestResourceEvidence[]
  limitations: string[]
}

const LIMITATIONS = [
  'One browser observation, without network or CPU throttling; not field performance or a Core Web Vitals certification.',
  'Resource Timing may hide cross-origin sizes. Zero sizes can mean a cached response or unavailable evidence; they do not prove a free transfer.',
  'Largest resources are ranked by visible encoded body bytes, then transfer bytes; only the first 100 resource timing entries and top 10 are included. Resource paths and queries are omitted.',
]

export async function installPerformanceObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const metrics: { largestContentfulPaintMs?: number; cumulativeLayoutShift?: number } = {}
    ;(window as Window & { __viewportWitnessMetrics?: typeof metrics }).__viewportWitnessMetrics =
      metrics
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1]
        if (last) metrics.largestContentfulPaintMs = last.startTime
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    } catch {
      /* Unsupported observers remain absent in the evidence. */
    }
    try {
      metrics.cumulativeLayoutShift = 0
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          if (!shift.hadRecentInput && typeof shift.value === 'number') {
            metrics.cumulativeLayoutShift = (metrics.cumulativeLayoutShift ?? 0) + shift.value
          }
        }
      }).observe({ type: 'layout-shift', buffered: true })
    } catch {
      delete metrics.cumulativeLayoutShift
      /* Unsupported observers remain absent in the evidence. */
    }
  })
}

interface ResourceTimingInput {
  name: string
  initiatorType: string
  transferSize: number
  encodedBodySize: number
  duration: number
}

const boundedMs = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 300_000
    ? Math.round(value)
    : undefined

const boundedBytes = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.min(15 * 1024 * 1024, Math.round(value)) : 0

/** Sanitize page-controlled timing data before it can enter a report. */
export function summarizeResources(entries: ResourceTimingInput[]): LargestResourceEvidence[] {
  const knownTypes = new Set([
    'script',
    'css',
    'img',
    'image',
    'link',
    'font',
    'fetch',
    'xmlhttprequest',
    'iframe',
    'video',
    'audio',
  ])
  return entries
    .slice(0, 100)
    .map((entry, index): LargestResourceEvidence => {
      let origin = '[redacted]'
      try {
        const url = new URL(entry.name)
        if (url.protocol === 'https:') origin = url.origin.slice(0, 300)
      } catch {
        /* Resource names need not be URLs. */
      }
      const transferredBytes = boundedBytes(entry.transferSize)
      const encodedBodyBytes = boundedBytes(entry.encodedBodySize)
      const durationMs = boundedMs(entry.duration)
      return {
        index: index + 1,
        origin,
        type: knownTypes.has(entry.initiatorType) ? entry.initiatorType : 'other',
        transferredBytes,
        encodedBodyBytes,
        ...(durationMs !== undefined ? { durationMs } : {}),
        sizeObservation:
          transferredBytes > 0 || encodedBodyBytes > 0 ? 'measured' : 'unavailable_or_cached',
      }
    })
    .sort(
      (a, b) =>
        b.encodedBodyBytes - a.encodedBodyBytes ||
        b.transferredBytes - a.transferredBytes ||
        a.index - b.index,
    )
    .slice(0, 10)
}

export async function collectPerformanceEvidence(
  page: Page,
  totals: PerformanceEvidence['resources'],
): Promise<PerformanceEvidence & { resourceDetails: ResourceDetails }> {
  const fallback: PerformanceEvidence & { resourceDetails: ResourceDetails } = {
    navigation: {},
    paint: {},
    resources: totals,
    resourceDetails: {
      observation: 'unavailable',
      largest: [],
      limitations: [...LIMITATIONS, 'Page timing evidence could not be collected.'],
    },
  }
  try {
    const measured = await withTimeout(
      page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined
        const paints = performance.getEntriesByType('paint')
        const paintValue = (name: string): number | undefined =>
          paints.find((entry) => entry.name === name)?.startTime
        const observed = (
          window as Window & {
            __viewportWitnessMetrics?: {
              largestContentfulPaintMs: number
              cumulativeLayoutShift: number
            }
          }
        ).__viewportWitnessMetrics
        return {
          navigation: navigation
            ? {
                dnsMs: navigation.domainLookupEnd - navigation.domainLookupStart,
                connectMs: navigation.connectEnd - navigation.connectStart,
                tlsMs:
                  navigation.secureConnectionStart > 0
                    ? navigation.connectEnd - navigation.secureConnectionStart
                    : undefined,
                requestMs: navigation.responseStart - navigation.requestStart,
                responseMs: navigation.responseEnd - navigation.responseStart,
                timeToFirstByteMs: navigation.responseStart - navigation.requestStart,
                domInteractiveMs: navigation.domInteractive,
                domContentLoadedMs: navigation.domContentLoadedEventEnd,
                loadEventMs: navigation.loadEventEnd,
              }
            : {},
          paint: {
            firstPaintMs: paintValue('first-paint'),
            firstContentfulPaintMs: paintValue('first-contentful-paint'),
            largestContentfulPaintMs: observed?.largestContentfulPaintMs,
            cumulativeLayoutShift: observed?.cumulativeLayoutShift,
          },
          entries: performance
            .getEntriesByType('resource')
            .slice(0, 100)
            .map((entry) => {
              const resource = entry as PerformanceResourceTiming
              return {
                name: resource.name.slice(0, 2048),
                initiatorType: resource.initiatorType,
                transferSize: resource.transferSize,
                encodedBodySize: resource.encodedBodySize,
                duration: resource.duration,
              }
            }),
        }
      }),
      2_000,
      'performance_timeout',
    )
    const cls = measured.paint.cumulativeLayoutShift
    const paint: PerformanceEvidence['paint'] = {}
    for (const key of [
      'firstPaintMs',
      'firstContentfulPaintMs',
      'largestContentfulPaintMs',
    ] as const) {
      const value = boundedMs(measured.paint[key])
      if (value !== undefined) paint[key] = value
    }
    if (typeof cls === 'number' && Number.isFinite(cls) && cls >= 0 && cls <= 100)
      paint.cumulativeLayoutShift = Number(cls.toFixed(4))
    return {
      navigation: Object.fromEntries(
        Object.entries(measured.navigation)
          .map(([key, value]) => [key, boundedMs(value)])
          .filter((entry): entry is [string, number] => entry[1] !== undefined),
      ),
      paint,
      resources: totals,
      resourceDetails: {
        observation: 'measured',
        largest: summarizeResources(measured.entries),
        limitations: LIMITATIONS,
      },
    }
  } catch {
    return fallback
  }
}
