/**
 * Graph copy — owned by the graph UI workstream. Add keys in both languages.
 */

export const zh = {
  'graph.scope.doc': '本文',
  'graph.scope.library': '全库',
  'graph.scope.switch': '图谱范围',
} as const

export const en: Record<keyof typeof zh, string> = {
  'graph.scope.doc': 'This paper',
  'graph.scope.library': 'Library',
  'graph.scope.switch': 'Graph scope',
}
