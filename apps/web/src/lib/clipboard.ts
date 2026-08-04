/**
 * Robust Copy-to-Clipboard Utility
 * Handles both modern navigator.clipboard API and legacy document.execCommand fallback
 * for non-HTTPS / HTTP / localhost browser environments.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. Try modern Async Clipboard API
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('Async Clipboard API failed, attempting fallback copy method:', err);
  }

  // 2. Legacy fallback for non-secure HTTP contexts or restricted environments
  try {
    if (typeof document !== 'undefined') {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.top = '-9999px';
      textArea.style.left = '-9999px';
      textArea.style.opacity = '0';
      textArea.setAttribute('readonly', '');
      document.body.appendChild(textArea);
      
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    }
  } catch (fallbackErr) {
    console.error('Fallback copy-to-clipboard failed:', fallbackErr);
  }

  return false;
}
