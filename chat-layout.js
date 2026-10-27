// Follow reflow only while the reader is already at the end of the chat.
// A narrower browser or an opening keyboard must not hide the latest reply;
// somebody scrolling back through earlier messages keeps their place.
(() => {
  const chat = document.getElementById('chat-win')
  if (!chat) return
  let following = true
  chat.addEventListener('scroll', () => {
    following = chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 32
  }, {passive:true})
  const keepEnd = () => {
    if (following) requestAnimationFrame(() => {if (following) chat.scrollTop = chat.scrollHeight})
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(keepEnd).observe(chat)
  window.addEventListener('resize', keepEnd)
  document.fonts?.ready?.then(keepEnd).catch(() => {})
})()
