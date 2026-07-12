import { v7 as generateUuidV7 } from 'uuid'

export function newId(): string {
  return generateUuidV7()
}
