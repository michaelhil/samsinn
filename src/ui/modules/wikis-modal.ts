// Settings > Wikis modal — list of configured wikis + add/refresh/delete +
// per-room binding toggles. Mirrors packs-modal.ts.

import { createModal, createButton } from './detail-modal.ts'
import { renderWikisInto, promptAddWiki } from './wikis-panel.ts'
import { icon } from './icon.ts'

export const openWikisModal = async (): Promise<void> => {
  const modal = createModal({ title: 'Wikis', width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)

  const closeBtn = modal.header.querySelector('button')!
  const addBtn = createButton({
    variant: 'ghost',
    icon: icon('plus', { size: 12 }),
    label: 'Add',
    title: 'Register a new wiki',
    className: 'mr-2',
    onClick: async () => {
      await promptAddWiki()
      await renderWikisInto(listEl)
    },
  })
  modal.header.insertBefore(addBtn, closeBtn)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  await renderWikisInto(listEl)

  // Re-render on wiki_changed WS events.
  const listener = (): void => { if (listEl.isConnected) void renderWikisInto(listEl) }
  window.addEventListener('wikis-changed', listener)
  const removalObserver = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      window.removeEventListener('wikis-changed', listener)
      removalObserver.disconnect()
    }
  })
  removalObserver.observe(document.body, { childList: true })
}
