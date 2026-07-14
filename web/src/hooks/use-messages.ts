import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  postMessage,
  retryPost,
  editPost,
  continuePost,
  postSetupMessage,
  kickoff,
  startOocSession,
} from '../api'

/** Invalidate everything that changes when a new message post lands. */
function invalidateAfterMessage(qc: ReturnType<typeof useQueryClient>, storyId: string) {
  qc.invalidateQueries({ queryKey: ['log', storyId] })
  qc.invalidateQueries({ queryKey: ['position', storyId] })
  qc.invalidateQueries({ queryKey: ['story-to-date', storyId] })
  qc.invalidateQueries({ queryKey: ['prompt-preview', storyId] })
}

export function usePostMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      content,
      generationOptions,
    }: {
      storyId: string
      content: string
      generationOptions?: Parameters<typeof postMessage>[2]
    }) => postMessage(storyId, content, generationOptions),
    onSuccess: (_data, { storyId }) => invalidateAfterMessage(qc, storyId),
  })
}

export function usePostSetupMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, content }: { storyId: string; content: string }) =>
      postSetupMessage(storyId, content),
    onSuccess: (_data, { storyId }) => invalidateAfterMessage(qc, storyId),
  })
}

export function useRetryPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      pageId,
      guidance,
      generationOptions,
    }: {
      storyId: string
      pageId: string
      guidance?: string
      generationOptions?: Parameters<typeof retryPost>[3]
    }) => retryPost(storyId, pageId, guidance, generationOptions),
    onSuccess: (_data, { storyId }) => invalidateAfterMessage(qc, storyId),
  })
}

export function useEditPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      pageId,
      content,
    }: {
      storyId: string
      pageId: string
      content: string
    }) => editPost(storyId, pageId, content),
    onSuccess: (_data, { storyId }) => invalidateAfterMessage(qc, storyId),
  })
}

export function useContinuePost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      guidance,
      generationOptions,
    }: {
      storyId: string
      guidance?: string
      generationOptions?: Parameters<typeof continuePost>[2]
    }) => continuePost(storyId, guidance, generationOptions),
    onSuccess: (_data, { storyId }) => invalidateAfterMessage(qc, storyId),
  })
}

export function useKickoff() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => kickoff(storyId),
    onSuccess: (_data, storyId) => {
      invalidateAfterMessage(qc, storyId)
      qc.invalidateQueries({ queryKey: ['phase', storyId] })
    },
  })
}

export function useStartOocSession() {
  return useMutation({
    mutationFn: (storyId: string) => startOocSession(storyId),
  })
}
