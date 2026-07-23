const promptText = document.getElementById('install-prompt').textContent;
const copyButtons = document.querySelectorAll('[data-copy-button]');

copyButtons.forEach((copyButton) => {
  const copyLabel = copyButton.querySelector('[data-copy-label]');
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      copyLabel.textContent = 'Copied';
    } catch {
      copyLabel.textContent = 'Copy failed';
    }
    window.setTimeout(() => {
      copyLabel.textContent = 'Copy';
    }, 1600);
  });
});
