
// Real Bot Protection Logic
function checkRealBotAuth() {
    const passwordInput = document.getElementById('real-bot-password');
    const loginDiv = document.getElementById('real-bot-login');
    const contentDiv = document.getElementById('real-bot-content');
    const errorMsg = document.getElementById('real-login-error');

    // Hardcoded password for simplicity (Client-side protection only)
    const PASS = "q2w3e4r5";

    if (passwordInput.value === PASS) {
        // Success
        loginDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        sessionStorage.setItem('realBotAuth', 'true');
        errorMsg.style.display = 'none';
    } else {
        // Fail
        errorMsg.style.display = 'block';
        passwordInput.value = '';
    }
}

// Bot (Paper) Protection Logic
function checkBotAuth() {
    const passwordInput = document.getElementById('bot-password');
    const loginDiv = document.getElementById('bot-login');
    const contentDiv = document.getElementById('bot-content');
    const errorMsg = document.getElementById('bot-login-error');

    // Same password for simplicity
    const PASS = "q2w3e4r5";

    if (passwordInput.value === PASS) {
        // Success
        loginDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        sessionStorage.setItem('botAuth', 'true');
        errorMsg.style.display = 'none';
    } else {
        // Fail
        errorMsg.style.display = 'block';
        passwordInput.value = '';
    }
}

// Info Tab Protection Logic
function checkInfoAuth() {
    const passwordInput = document.getElementById('info-password');
    const loginDiv = document.getElementById('info-login');
    const contentDiv = document.getElementById('info-content');
    const errorMsg = document.getElementById('info-login-error');

    // Same password for now
    const PASS = "admin369";

    if (passwordInput.value === PASS) {
        // Success
        loginDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        sessionStorage.setItem('infoAuth', 'true');
        errorMsg.style.display = 'none';
    } else {
        // Fail
        errorMsg.style.display = 'block';
        passwordInput.value = '';
    }
}

// Auto-check on load (if using tabs that don't reload page)
document.addEventListener('DOMContentLoaded', () => {
    // Check Real Bot Auth
    const isRealAuth = sessionStorage.getItem('realBotAuth');
    if (isRealAuth === 'true') {
        const loginDiv = document.getElementById('real-bot-login');
        const contentDiv = document.getElementById('real-bot-content');
        if (loginDiv && contentDiv) {
            loginDiv.style.display = 'none';
            contentDiv.style.display = 'block';
        }
    }

    // Check Bot (Paper) Auth
    const isBotAuth = sessionStorage.getItem('botAuth');
    if (isBotAuth === 'true') {
        const loginDiv = document.getElementById('bot-login');
        const contentDiv = document.getElementById('bot-content');
        if (loginDiv && contentDiv) {
            loginDiv.style.display = 'none';
            contentDiv.style.display = 'block';
        }
    }

    // Check Info Auth
    const isInfoAuth = sessionStorage.getItem('infoAuth');
    if (isInfoAuth === 'true') {
        const loginDiv = document.getElementById('info-login');
        const contentDiv = document.getElementById('info-content');
        if (loginDiv && contentDiv) {
            loginDiv.style.display = 'none';
            contentDiv.style.display = 'block';
        }
    }
});
