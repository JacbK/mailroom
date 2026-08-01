const copyButtons = document.querySelectorAll('[data-copy-button]');

function fallbackCopy(element) {
  const selection = window.getSelection();
  if (!selection) return false;
  const priorRanges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  const copied = document.execCommand('copy');
  selection.removeAllRanges();
  priorRanges.forEach((prior) => selection.addRange(prior));
  return copied;
}

copyButtons.forEach((copyButton) => {
  const copyLabel = copyButton.querySelector('[data-copy-label]');
  const copyStatus = copyButton.parentElement.querySelector('[data-copy-status]');
  const prompt = document.getElementById(copyButton.dataset.copyTarget);
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt.textContent);
      else if (!fallbackCopy(prompt)) throw new Error('Clipboard unavailable');
      copyLabel.textContent = 'Copied';
      copyStatus.textContent = 'Copied to clipboard';
    } catch {
      copyLabel.textContent = 'Copy failed';
      copyStatus.textContent = 'Copy failed';
    }
    window.setTimeout(() => {
      copyLabel.textContent = 'Copy';
      copyStatus.textContent = '';
    }, 1600);
  });
});
