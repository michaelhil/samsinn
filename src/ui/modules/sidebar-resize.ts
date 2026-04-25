// Sidebar resize — drag the handle on the sidebar's right edge to resize.
// Drag below the collapse threshold to fully hide the sidebar (width 0);
// the handle remains at the viewport's left edge as a peek-back grip.
//
// Width is persisted to localStorage. Collapsed state is simply "width === 0".

import { $sidebarWidth } from './stores.ts'

const MIN_WIDTH = 120     // anything smaller than this snaps to 0 on release
const DEFAULT_WIDTH = 160
const MAX_WIDTH = 400

export const initSidebarResize = (): void => {
  const sidebar = document.getElementById('sidebar') as HTMLElement | null
  const handle = document.getElementById('sidebar-resize') as HTMLElement | null
  if (!sidebar || !handle) return

  const applyWidth = (w: number): void => {
    sidebar.style.width = `${w}px`
    // Keep a 1px sliver of sidebar even when collapsed so the border-right
    // remains visible as a "there's something hidden here" hint. The handle
    // itself sits on top of that border.
    handle.style.left = `${w}px`
  }

  // Hydrate from atom (which read localStorage on boot).
  applyWidth($sidebarWidth.get())
  $sidebarWidth.subscribe(applyWidth)

  let dragging = false
  let lastWidth = $sidebarWidth.get() || DEFAULT_WIDTH

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return
    const raw = Math.max(0, Math.min(MAX_WIDTH, e.clientX))
    // Snap to 0 below MIN_WIDTH so you get a crisp collapse instead of a
    // cramped 40px sidebar.
    const w = raw < MIN_WIDTH ? 0 : raw
    if (w > 0) lastWidth = w
    $sidebarWidth.set(w)
  }

  const onMouseUp = (): void => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('dragging')
    document.body.classList.remove('sidebar-dragging')
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    localStorage.setItem('samsinn-sidebar-width', String($sidebarWidth.get()))
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    // Click (no drag) when the sidebar is collapsed: expand to lastWidth.
    if ($sidebarWidth.get() === 0) {
      $sidebarWidth.set(lastWidth || DEFAULT_WIDTH)
      localStorage.setItem('samsinn-sidebar-width', String($sidebarWidth.get()))
      return
    }
    dragging = true
    handle.classList.add('dragging')
    document.body.classList.add('sidebar-dragging')
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  })
}
