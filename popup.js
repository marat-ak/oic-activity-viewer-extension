document.addEventListener('DOMContentLoaded', () => {
  const instanceIdInput = document.getElementById('instanceId');
  const openBtn = document.getElementById('openBtn');
  const autoDetectToggle = document.getElementById('autoDetect');
  const themeSelect = document.getElementById('themeSelect');
  const statusEl = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['autoDetect', 'lastInstanceId', 'viewerTheme'], (data) => {
    autoDetectToggle.checked = !!data.autoDetect;
    if (data.lastInstanceId) instanceIdInput.value = data.lastInstanceId;
    if (data.viewerTheme) themeSelect.value = data.viewerTheme;
  });

  // Save auto-detect setting and notify content script
  autoDetectToggle.addEventListener('change', () => {
    const val = autoDetectToggle.checked;
    chrome.storage.local.set({ autoDetect: val });
    // Notify all OIC tabs
    chrome.tabs.query({ url: '*://*.oraclecloud.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'settingsChanged', autoDetect: val }).catch(() => {});
      }
    });
  });

  // Save theme setting and notify content scripts
  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value;
    chrome.storage.local.set({ viewerTheme: theme });
    chrome.tabs.query({ url: '*://*.oraclecloud.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'themeChanged', theme }).catch(() => {});
      }
    });
  });

  // Open viewer
  openBtn.addEventListener('click', () => {
    const instanceId = instanceIdInput.value.trim();
    if (!instanceId) {
      statusEl.textContent = 'Please enter an Instance ID';
      statusEl.className = 'status error';
      instanceIdInput.focus();
      return;
    }

    chrome.storage.local.set({ lastInstanceId: instanceId });

    // Send message to the active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        statusEl.textContent = 'No active tab found';
        statusEl.className = 'status error';
        return;
      }

      const tab = tabs[0];
      if (!tab.url || !tab.url.includes('oraclecloud.com')) {
        statusEl.textContent = 'Please navigate to an OIC page first';
        statusEl.className = 'status error';
        return;
      }

      chrome.tabs.sendMessage(tab.id, {
        type: 'openViewer',
        instanceId: instanceId
      }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not loaded yet, inject it
          statusEl.textContent = 'Injecting script...';
          statusEl.className = 'status';
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          }).then(() =>
            chrome.scripting.insertCSS({
              target: { tabId: tab.id },
              files: ['content.css']
            })
          ).then(() => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'openViewer',
              instanceId: instanceId
            });
            window.close();
          });
          return;
        }
        window.close();
      });
    });
  });

  // Import JSON file
  document.getElementById('importBtn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      statusEl.textContent = 'Reading file...';
      statusEl.className = 'status';
      const reader = new FileReader();
      reader.onload = () => {
        let data;
        try {
          data = JSON.parse(reader.result);
          if (!data.items || !Array.isArray(data.items)) {
            statusEl.textContent = 'Invalid file: missing items array';
            statusEl.className = 'status error';
            return;
          }
        } catch (e) {
          statusEl.textContent = 'Failed to parse JSON: ' + e.message;
          statusEl.className = 'status error';
          return;
        }

        // Send data to the active tab's content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs[0]) {
            statusEl.textContent = 'No active tab found';
            statusEl.className = 'status error';
            return;
          }

          const tab = tabs[0];
          const sendImport = () => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'importData',
              data: data
            }, (response) => {
              if (chrome.runtime.lastError) {
                statusEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
                statusEl.className = 'status error';
                return;
              }
              window.close();
            });
          };

          // Try sending directly; if content script not loaded, inject first
          chrome.tabs.sendMessage(tab.id, { type: 'ping' }, (response) => {
            if (chrome.runtime.lastError) {
              // Inject content script first
              statusEl.textContent = 'Injecting viewer...';
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
              }).then(() =>
                chrome.scripting.insertCSS({
                  target: { tabId: tab.id },
                  files: ['content.css']
                })
              ).then(() => {
                setTimeout(sendImport, 300);
              });
            } else {
              sendImport();
            }
          });
        });
      };
      reader.readAsText(file);
    });
    input.click();
  });

  // Enter key in input
  instanceIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openBtn.click();
  });

  // Focus input
  instanceIdInput.focus();
});
