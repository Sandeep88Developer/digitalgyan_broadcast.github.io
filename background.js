// AuraCast Background Service Worker

// Keep track of the active recorder tab ID and recording state
let recorderTabId = null;
let recordingState = {
  status: 'idle', // 'idle', 'recording', 'paused'
  startTime: null,
  options: null
};

// Listen for messages from popup, content scripts, and dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message, 'from:', sender);

  switch (message.action) {
    case 'START_RECORDING':
      startRecording(message.options, sendResponse);
      return true; // Keep message channel open for async response

    case 'STOP_RECORDING':
    case 'PAUSE_RECORDING':
    case 'RESUME_RECORDING':
      // Forward recording control commands to the dashboard tab
      forwardToDashboard(message);
      sendResponse({ success: true });
      break;

    case 'RECORDING_STATE_CHANGED':
      recordingState.status = message.status;
      recordingState.startTime = message.startTime;
      if (message.options) recordingState.options = message.options;
      
      // Save to storage so other components can access it
      chrome.storage.local.set({ recordingState });
      
      // Broadcast state change to all active extension pages and content scripts
      broadcastMessage({
        action: 'STATE_UPDATED',
        state: recordingState
      });
      sendResponse({ success: true });
      break;

    case 'GET_RECORDING_STATE':
      sendResponse({ state: recordingState });
      break;

    case 'TOGGLE_CAMERA_BUBBLE':
      toggleCameraBubbleInActiveTab(sendResponse);
      return true;

    case 'CLOSE_CAMERA_BUBBLE':
      forwardToActiveTab({ action: 'CLOSE_CAMERA_BUBBLE' });
      sendResponse({ success: true });
      break;

    case 'UPDATE_BUBBLE_SETTINGS':
      forwardToActiveTab(message);
      sendResponse({ success: true });
      break;

    default:
      console.warn('Unknown action:', message.action);
      sendResponse({ error: 'Unknown action' });
  }
});

// Start the recording process by opening/focusing the dashboard
function startRecording(options, sendResponse) {
  // Save recording configuration to storage
  chrome.storage.local.set({ pendingRecordingConfig: options }, () => {
    // If we already have a dashboard tab, focus it
    if (recorderTabId) {
      chrome.tabs.get(recorderTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          createNewDashboard(sendResponse);
        } else {
          chrome.tabs.update(recorderTabId, { active: true }, () => {
            // Tell the dashboard to start recording
            chrome.tabs.sendMessage(recorderTabId, { action: 'TRIGGER_CAPTURE' });
            sendResponse({ success: true, tabId: recorderTabId });
          });
        }
      });
    } else {
      createNewDashboard(sendResponse);
    }
  });
}

// Create a new dashboard tab
function createNewDashboard(sendResponse) {
  const dashboardUrl = chrome.runtime.getURL('dashboard.html?start=true');
  chrome.tabs.create({ url: dashboardUrl }, (tab) => {
    recorderTabId = tab.id;
    sendResponse({ success: true, tabId: tab.id });
  });
}

// Clean up tracker if dashboard tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recorderTabId) {
    recorderTabId = null;
    if (recordingState.status !== 'idle') {
      recordingState.status = 'idle';
      recordingState.startTime = null;
      chrome.storage.local.set({ recordingState });
      broadcastMessage({ action: 'STATE_UPDATED', state: recordingState });
    }
  }
});

// Inject or toggle camera bubble script in the active webpage
function toggleCameraBubbleInActiveTab(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) {
      sendResponse({ success: false, error: 'No active tab found' });
      return;
    }

    const activeTab = tabs[0];
    
    // Do not inject on Chrome system pages (chrome://, chrome-extension://, edge://, etc.)
    if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('view-source:')) {
      sendResponse({ success: false, error: 'Cannot inject webcam overlay on system pages' });
      return;
    }

    // Ping the tab first to see if content.js is already running
    chrome.tabs.sendMessage(activeTab.id, { action: 'PING' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.pong) {
        // Content script is not injected yet, let's inject it
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['content.js']
        }, () => {
          if (chrome.runtime.lastError) {
            console.error('Failed to inject script:', chrome.runtime.lastError);
            sendResponse({ success: false, error: 'Failed to inject overlay' });
            return;
          }
          
          // Also inject CSS
          chrome.scripting.insertCSS({
            target: { tabId: activeTab.id },
            files: ['content.css']
          }, () => {
            // Once injected, trigger the bubble toggle
            chrome.tabs.sendMessage(activeTab.id, { action: 'TOGGLE_CAMERA' }, (toggleRes) => {
              sendResponse({ success: true, active: toggleRes?.active });
            });
          });
        });
      } else {
        // Content script is already active, just toggle
        chrome.tabs.sendMessage(activeTab.id, { action: 'TOGGLE_CAMERA' }, (toggleRes) => {
          sendResponse({ success: true, active: toggleRes?.active });
        });
      }
    });
  });
}

// Helper: forward message to the dashboard tab
function forwardToDashboard(message) {
  if (recorderTabId) {
    chrome.tabs.sendMessage(recorderTabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Failed to forward message to dashboard:', chrome.runtime.lastError);
      }
    });
  }
}

// Helper: forward message to active tab content script
function forwardToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          // Script might not be loaded, ignore
        }
      });
    }
  });
}

// Helper: broadcast message to all extension views
function broadcastMessage(message) {
  // To tabs
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message, () => {
        // Suppress errors for tabs without content scripts
        const err = chrome.runtime.lastError;
      });
    });
  });
  
  // To extension views (popup, dashboard)
  chrome.runtime.sendMessage(message, () => {
    const err = chrome.runtime.lastError;
  });
}
