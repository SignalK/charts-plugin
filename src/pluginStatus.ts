// Builds the human-readable message shown in the admin UI plugin status banner
// after startup. Motivation: issue #8 - users who add a new chart path want to
// see per-path feedback ("Found 0 charts from /foo") so they can tell whether
// their path resolved and picked anything up.

export interface ChartPathCount {
  chartPath: string
  count: number
}

// Examples:
//   composeStatus([{chartPath: '/a', count: 5}], 0)
//     -> "Started - Found 5 charts from /a"
//   composeStatus([{chartPath: '/a', count: 0}], 2)
//     -> "Started - Found 0 charts from /a + 2 online providers"
//   composeStatus([{chartPath: '/a', count: 2}, {chartPath: '/b', count: 3}], 0)
//     -> "Started - Found 5 charts: /a (2), /b (3)"
export function composeStatus(
  perPath: ChartPathCount[],
  onlineProviderCount: number
): string {
  const totalCharts = perPath.reduce((sum, p) => sum + p.count, 0)
  let chartsPart: string
  if (perPath.length === 0) {
    chartsPart = `Found ${totalCharts} ${plural('chart', totalCharts)}`
  } else if (perPath.length === 1) {
    chartsPart = `Found ${totalCharts} ${plural('chart', totalCharts)} from ${
      perPath[0]!.chartPath
    }`
  } else {
    const breakdown = perPath
      .map((p) => `${p.chartPath} (${p.count})`)
      .join(', ')
    chartsPart = `Found ${totalCharts} ${plural(
      'chart',
      totalCharts
    )}: ${breakdown}`
  }
  const onlinePart =
    onlineProviderCount > 0
      ? ` + ${onlineProviderCount} online ${plural(
          'provider',
          onlineProviderCount
        )}`
      : ''
  return `Started - ${chartsPart}${onlinePart}`
}

const plural = (word: string, n: number) => (n === 1 ? word : `${word}s`)
