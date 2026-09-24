# AI-Powered Cold Emailer 🚀

An AI-driven cold outreach and job application email assistant with Gemini AI integration, multi-user profile support, automated job posting extraction, and one-click Gmail sending with CV attachments.

---

## ✨ Features

- **Multi-User Profile Switching**: Switch between profiles with custom skills, experience, and resumes.
- **Smart Job Post Extraction**: Automatically parse job roles, emails, phone numbers, and company details from text or screenshots using Gemini AI.
- **Context-Aware Email Generation**: Craft tailored, human-sounding cover emails and WhatsApp outreach messages.
- **Direct Gmail Dispatch**: Seamless dispatch via Gmail SMTP using Nodemailer and dedicated App Passwords.
- **Sent Emails Log & Follow-Up Tracking**: Log sent applications and generate one-click polite follow-up messages.

---

## 🛠️ Getting Started

### 1. Prerequisites
- Node.js (v18+)
- Google Gemini API Key ([Google AI Studio](https://aistudio.google.com/))
- Google Account with 2-Step Verification and an [App Password](https://myaccount.google.com/apppasswords)

### 2. Installation
```bash
git clone https://github.com/kmskhn/AI-Power-Cold-Emailer.git
cd AI-Power-Cold-Emailer
npm install
```

### 3. Environment Configuration
Copy the template `.env.example` to `.env`:
```bash
cp .env.example .env
```

Configure your credentials in `.env`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
PORT=4000

# Gmail App Passwords (per user ID: GMAIL_APP_PASSWORD_<USER_ID>)
GMAIL_APP_PASSWORD_JOHNDEV="xxxx xxxx xxxx xxxx"
GMAIL_APP_PASSWORD_JANEDATA="xxxx xxxx xxxx xxxx"
```

### 4. User Profiles Setup
Copy the template `users.example.json` to `users.local.json` (or `users.json`):
```bash
cp users.example.json users.local.json
```
Edit `users.local.json` with your real profile details and place your resume PDF files in `public/cvs/` or `public/`.

> **Note:** `.env`, `users.local.json`, `users.json`, and `*.pdf` files are git-ignored by default for privacy and security.

### 5. Running the Application
```bash
# Run in development mode with nodemon
npm run dev

# Or start in production
npm start
```

Visit [http://localhost:4000](http://localhost:4000) in your browser.

---

## 🔒 Security Best Practices

- Never commit `.env` or files containing plaintext passwords or API keys.
- Store Gmail App Passwords exclusively in `.env` using the format `GMAIL_APP_PASSWORD_<USER_ID>`.
- Keep private candidate resumes and profile details in `users.local.json` or local folders.

---

## 📄 License
ISC
