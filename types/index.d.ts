export type TicketType = 'grilling' | 'prototype' | 'research' | 'task' | 'unknown'

export type Ticket = {
  /** "07" for a local ticket file, "#57" for a GitHub issue. */
  id: string
  title: string
  type: TicketType
  /** Needs a human in the loop. */
  hitl: boolean
  closed: boolean
  /** Empty when unclaimed. */
  assignee: string
  blockedBy: string[]
  /** Absolute path of a local ticket file. */
  path?: string
  /** URL of a GitHub issue. */
  url?: string
  /** Set when the file or issue could not be read fully. */
  warning?: string
}

export type WfMap = {
  /** Absolute map.md path, a plain plan's absolute folder path, or "github:<owner>/<repo>#<n>". */
  key: string
  tracker: 'local' | 'github'
  /**
   * wayfinder: a map.md (or GitHub map); its tickets start with `/wayfinder <map> <ticket>`.
   * plan: a folder of numbered ticket files with no map.md; its tickets start with the plan prompt.
   * Absent means wayfinder.
   */
  kind?: 'wayfinder' | 'plan'
  title: string
  destination: string
  fog: string[]
  decisions: number
  tickets: Ticket[]
  /** Local: map.md path (or a plan's folder) relative to the session root. */
  relPath?: string
  /** GitHub: the map issue's URL. */
  url?: string
  repo?: string
  number?: number
  error?: string
}

export type Flow = {
  mapKey: string
  ids: string[]
  stage: 'ask' | 'writing' | 'ready'
  handoffPath?: string
  startedAt: number
}

/** A ticket this session launched and that has not been claimed yet. */
export type Launch = { mapKey: string; id: string; at: number }

export type Flash = { ids: string[]; until: number }

/** One session's context fill, as published to the shared store by each tab running the mod. */
export type Ctx = {
  /** "you" for this session, else a short session id. */
  who: string
  /** Tickets it holds, as "<map key>|<ticket id>". */
  keys: string[]
  /** Input tokens of its last response; absent before its first. */
  tokens?: number
  /** Its model's context window. */
  window: number
  /** When it last reported. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'wayfinder-sidebar': {
      maps: Shaped<WfMap[]>
      active: string
      sel: string
      flow: Shaped<Flow | null>
      picked: string[]
      launches: Shaped<Launch[]>
      flash: Shaped<Flash | null>
      mine: string[]
      working: string[]
      peers: Shaped<Record<string, string>>
      showDone: boolean
      spin: number
      contexts: Shaped<Ctx[]>
      selfCtx: Shaped<{ tokens?: number; window: number } | null>
    }
  }
}
