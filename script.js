const chatBox = document.querySelector('.chat-box');
const inputField = chatBox.querySelector('input[type="text"]');
const button = chatBox.querySelector('.chat-box-footer button');
const chatBoxBody = chatBox.querySelector('.chat-box-body');
const themeToggleButtons = document.querySelectorAll('.theme-toggle-btn');
const html = document.documentElement;
const newChatBtn = document.querySelector('.new-chat-btn');

//

const SERVER_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://senior-nbsj.onrender.com"; // replace with actual Render link


const savedTheme = localStorage.getItem('theme') || 'light';
html.setAttribute('data-theme', savedTheme);


let currentSessionId = Date.now().toString();
let chatHistory = [];

function saveChatLocally() {
  localStorage.setItem(currentSessionId, JSON.stringify(chatHistory));
  const title = chatHistory.find(m => m.type === 'message')?.content.slice(0, 20) || 'New Chat';
  localStorage.setItem(`${currentSessionId}_title`, title);
  updateSavedChatsSidebar();
}

function updateSavedChatsSidebar() {
  const sidebarChatList = document.querySelector('.sidebar-chat-list');
  if (!sidebarChatList) return;
  sidebarChatList.innerHTML = '';
  Object.keys(localStorage).forEach(key => {
    if (key.endsWith('_title')) {
      const sessionId = key.replace('_title', '');
      const chatName = localStorage.getItem(key);
      addSavedChat(sessionId, chatName);
    }
  });
}


// Event listeners
button.addEventListener('click', () => {
  if (inputField.value.trim() !== '') sendMessage();
});
inputField.addEventListener('keypress', (e) => e.key === 'Enter' && inputField.value.trim() !== '' && sendMessage());

themeToggleButtons.forEach(btn => {
  btn.setAttribute('type', 'button');
  btn.addEventListener('click', toggleTheme);
});

// Get the Clear Chat button and add event listener
const clearChatBtn = document.getElementById('clear-chat');
if (clearChatBtn) {
  clearChatBtn.addEventListener('click', clearChat);
}

// New chat button event listener
if (newChatBtn) {
  newChatBtn.addEventListener('click', startNewChat);
}

function toggleTheme() {
  const newTheme = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  console.log(`Theme changed to ${newTheme} mode`);
}

function clearChat() {
  const messages = chatBoxBody.querySelectorAll('div');
  messages.forEach(msg => msg.remove());
  inputField.focus();
  updateSavedChatsSidebar();
}

function startNewChat() {
  clearChat();
  currentSessionId = Date.now().toString();
  chatHistory = [];
}

function loadSavedChat(chatId, chatName) {
  clearChat();
  const saved = localStorage.getItem(chatId);
  if (saved) {
    chatHistory = JSON.parse(saved);
    currentSessionId = chatId;
    chatHistory.forEach(msg => appendMessage(msg.type, msg.content));
  } else {
    appendMessage('system', `No saved chat found for "${chatName}"`);
  }
}

function isValidMessage(message) {
  return message && message.trim().length > 0 && message.length < 500;
}

async function sendMessage() {
  const message = inputField.value.trim();
  if (!isValidMessage(message)) {
    appendMessage('response error', 'Please enter a valid question (1-500 characters)');
    return;
  }

  inputField.value = '';
  appendMessage('message', message);
  const loadingElement = showLoading();
  button.disabled = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`${SERVER_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMessage = 'Server error occurred';
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
      } catch (e) {
        errorMessage = await response.text() || `Request failed with status ${response.status}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    appendMessage('response', data.message);
    localStorage.setItem('lastResponse', data.message);
  } catch (error) {
    console.error('Request Error:', error);
    const cached = localStorage.getItem('lastResponse');
    if (cached) {
      appendMessage('response error', `⚠️ Error: ${error.message}. Here's the last cached answer:`);
      appendMessage('response', cached);
    } else if (error.name === 'AbortError') {
      appendMessage('response error', 'The request timed out.');
    } else if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
      appendMessage('response error', `Connection error: Unable to reach server at ${SERVER_URL}`);
    } else {
      appendMessage('response error', `Error: ${error.message}`);
    }
  } finally {
    hideLoading(loadingElement);
    button.disabled = false;
  }
}

// Helper function to add a new saved chat to the sidebar
function addSavedChat(chatId, chatName) {
  const sidebarChatList = document.querySelector('.sidebar-chat-list');
  const chatElement = document.createElement('div');
  chatElement.className = 'saved-chat';
  
  // Create a container for the chat name
  const chatNameElement = document.createElement('span');
  chatNameElement.className = 'chat-name';
  chatNameElement.textContent = chatName;
  
  // Create delete icon
  const deleteIcon = document.createElement('i');
  deleteIcon.className = 'fas fa-trash delete-chat-icon';
  deleteIcon.title = 'Delete this chat';
  
  // Add delete event to the icon
  deleteIcon.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering the parent click event
    deleteSavedChat(chatId, chatName);
  });
  
  // Add main click event to load the chat
  chatElement.dataset.chatId = chatId;
  chatElement.addEventListener('click', () => {
    loadSavedChat(chatId, chatName);
  });
  
  // Append elements to the chat item
  chatElement.appendChild(chatNameElement);
  chatElement.appendChild(deleteIcon);
  
  sidebarChatList.appendChild(chatElement);
}

// New function to handle chat deletion
function deleteSavedChat(chatId, chatName) {
  // Confirm deletion
  if (confirm(`Are you sure you want to delete "${chatName}"?`)) {
    // Remove from localStorage
    localStorage.removeItem(chatId);
    localStorage.removeItem(`${chatId}_title`);
    
    // Update sidebar
    updateSavedChatsSidebar();
    
    // If the deleted chat was the current one, start a new chat
    if (chatId === currentSessionId) {
      startNewChat();
    }
  }
}

function appendMessage(type, content) {
  const messageElement = document.createElement('div');
  messageElement.className = type;
  messageElement.innerHTML = typeof content === 'string' ? content.replace(/\n/g, '<br>') : content;
  chatBoxBody.appendChild(messageElement);
  scrollToBottom();

  if (type === 'message' || type === 'response') {
    chatHistory.push({ type, content });
    saveChatLocally();
  }
}

function showLoading() {
  const loadingElement = document.createElement('div');
  loadingElement.className = 'response loading';
  loadingElement.innerHTML = 'AI is Thinking <span class="dots">...</span>';
  chatBoxBody.appendChild(loadingElement);

  const dots = loadingElement.querySelector('.dots');
  const intervalId = setInterval(() => {
    dots.textContent = '.'.repeat((dots.textContent.length % 3) + 1);
  }, 500);

  loadingElement.dataset.intervalId = intervalId;
  scrollToBottom();
  return loadingElement;
}

function hideLoading(loadingElement) {
  if (!loadingElement) return;
  clearInterval(parseInt(loadingElement.dataset.intervalId));
  loadingElement.remove();
}

function scrollToBottom() {
  chatBoxBody.scrollTop = chatBoxBody.scrollHeight;
}

window.addEventListener('DOMContentLoaded', () => {
  inputField.focus();
  updateSavedChatsSidebar();
  fetch(`${SERVER_URL}/api/health`)
    .then(response => {
      if (!response.ok) throw new Error('Server health check failed');
      return response.json();
    })
    .then(data => {
      console.log('Server status:', data.status);
      // Removed the connection success message
    })
    .catch(error => {
      console.error('Server health check failed:', error);
      appendMessage('response error', 'Warning: Could not connect to the server.');
    });
});