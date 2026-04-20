export interface Ownable {
  cookie: string
  userId: string | null
}

export interface Caller {
  cookie: string
  userId: string | null
}

/**
 * A grade is owned by the caller if their cookies match, OR the caller is a
 * verified user and the grade is bound to that user. null userId never counts
 * as a match — that would make two anonymous visitors on different cookies
 * "own" each other's nulls.
 */
export function isOwnedBy(grade: Ownable, caller: Caller): boolean {
  if (grade.cookie === caller.cookie) return true
  if (caller.userId !== null && grade.userId === caller.userId) return true
  return false
}
