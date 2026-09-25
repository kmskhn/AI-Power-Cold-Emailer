const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

require('dotenv').config();

const {
  generateText,
  generateFromImage,
} = require('./services/openrouter');

const {
  parseJobPost,
} = require('./services/jobParser');

const {
  buildImageExtractionPrompt,
  buildEmailPrompt,
  buildFollowUpPrompt,
} = require('./services/prompts');

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;

const USERS_LOCAL_PATH = path.resolve(
  __dirname,
  'users.local.json'
);

const USERS_DEFAULT_PATH = path.resolve(
  __dirname,
  'users.json'
);

const USERS_EXAMPLE_PATH = path.resolve(
  __dirname,
  'users.example.json'
);

const SENT_JSON = path.resolve(
  __dirname,
  '..',
  'sent_emails.json'
);

// ─────────────────────────────────────────────────────────────────────────────
// OPENROUTER API KEY
// ─────────────────────────────────────────────────────────────────────────────

function resolveOpenRouterApiKey(req, user) {
  /*
   * Optional per-user BYOK support.
   *
   * Priority:
   * 1. Request header
   * 2. User profile
   * 3. Global environment variable
   */

  const headerKey =
    req.headers['x-openrouter-key'] ||
    req.headers['authorization']?.replace(
      /^Bearer\s+/i,
      ''
    );

  const userKey = user?.openrouterApiKey;

  const globalKey =
    process.env.OPENROUTER_API_KEY;

  if (headerKey?.trim()) {
    return headerKey.trim();
  }

  if (userKey?.trim()) {
    return userKey.trim();
  }

  if (globalKey?.trim()) {
    return globalKey.trim();
  }

  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────

function getUsersFilePath() {
  if (fs.existsSync(USERS_LOCAL_PATH)) {
    return USERS_LOCAL_PATH;
  }

  if (fs.existsSync(USERS_DEFAULT_PATH)) {
    return USERS_DEFAULT_PATH;
  }

  return USERS_EXAMPLE_PATH;
}

function loadUsers() {
  if (process.env.USERS_JSON) {
    try {
      const parsed = JSON.parse(
        process.env.USERS_JSON
      );

      if (
        Array.isArray(parsed) &&
        parsed.length > 0
      ) {
        return parsed;
      }
    } catch (error) {
      console.error(
        'Failed to parse USERS_JSON:',
        error.message
      );
    }
  }

  const filePath = getUsersFilePath();

  try {
    return JSON.parse(
      fs.readFileSync(
        filePath,
        'utf-8'
      )
    );
  } catch {
    return [];
  }
}

function getUserPassword(user) {
  if (!user) return '';

  const cleanId = (
    user.id || ''
  )
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toUpperCase();

  return (
    process.env[
    `GMAIL_APP_PASSWORD_${cleanId}`
    ] ||
    user.gmailAppPassword ||
    ''
  );
}

function getUser(userId) {
  const users = loadUsers();

  const user =
    users.find(u => u.id === userId) ||
    users[0];

  if (!user) {
    return null;
  }

  return {
    ...user,
    gmailAppPassword:
      getUserPassword(user),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SENT EMAIL STORE
// ─────────────────────────────────────────────────────────────────────────────

function loadSent() {
  if (!fs.existsSync(SENT_JSON)) {
    return [];
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        SENT_JSON,
        'utf-8'
      )
    );
  } catch {
    return [];
  }
}

function saveSent(entries) {
  fs.writeFileSync(
    SENT_JSON,
    JSON.stringify(
      entries,
      null,
      2
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function stripFences(text) {
  return String(text || '')
    .replace(
      /^```json\s*/i,
      ''
    )
    .replace(
      /^```\s*/i,
      ''
    )
    .replace(
      /```\s*$/i,
      ''
    )
    .trim();
}

function isValidEmailGeneration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  if (
    typeof value.subject !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.whatsapp !== 'string'
  ) {
    return false;
  }

  if (!value.subject.trim()) {
    return false;
  }

  if (!value.body.trim()) {
    return false;
  }

  if (!value.whatsapp.trim()) {
    return false;
  }

  return true;
}


function parseJsonResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('LLM returned an empty response.');
  }

  let text = raw.trim();

  // Remove Markdown code fences if a model ignores the prompt.
  text = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // First attempt: direct JSON.parse().
  try {
    const parsed = JSON.parse(text);

    if (isValidEmailGeneration(parsed)) {
      return parsed;
    }
  } catch {
    // Continue with JSON extraction.
  }

  // Find the first JSON object inside surrounding text.
  const start = text.indexOf('{');

  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === '{') {
        depth++;
      }

      if (char === '}') {
        depth--;

        if (depth === 0) {
          const candidate =
            text.slice(start, i + 1);

          try {
            const parsed =
              JSON.parse(candidate);

            if (isValidEmailGeneration(parsed)) {
              return parsed;
            }
          } catch {
            // Continue to failure below.
          }

          break;
        }
      }
    }
  }

  const preview =
    raw
      .replace(/\s+/g, ' ')
      .slice(0, 500);

  const error =
    new Error(
      `LLM returned invalid JSON. Response preview: ${preview}`
    );

  error.retryable = true;

  throw error;
}



function formatEmailHtml(text) {
  return String(text || '')
    .replace(
      /\*\*(.*?)\*\*/g,
      '<b>$1</b>'
    )
    .replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" style="color:#1a73e8;text-decoration:none;">$1</a>'
    )
    .replace(
      /\n/g,
      '<br/>'
    );
}

function createGmailTransporter(user) {
  if (!user?.email) {
    throw new Error(
      'User email is missing.'
    );
  }

  if (!user.gmailAppPassword) {
    const envKey =
      `GMAIL_APP_PASSWORD_${(
        user.id || ''
      )
        .replace(
          /[^a-zA-Z0-9]/g,
          '_'
        )
        .toUpperCase()}`;

    throw new Error(
      `Gmail App Password not found for ${user.name || user.id}. Please set ${envKey} in .env`
    );
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user.email,
      pass: user.gmailAppPassword,
    },
  });
}

function getCvAttachment(user) {
  if (!user?.cvFile) {
    return [];
  }

  const cvPath = path.resolve(
    __dirname,
    'public',
    'cvs',
    user.cvFile
  );

  const cvFallback = path.resolve(
    __dirname,
    'public',
    user.cvFile
  );

  const resolvedCv =
    fs.existsSync(cvPath)
      ? cvPath
      : fs.existsSync(cvFallback)
        ? cvFallback
        : null;

  if (!resolvedCv) {
    console.warn(
      'CV not found for user:',
      user.id
    );

    return [];
  }

  return [
    {
      filename: user.cvFile,
      path: resolvedCv,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET USERS
// ─────────────────────────────────────────────────────────────────────────────

app.get(
  '/api/users',
  (req, res) => {
    const users = loadUsers().map(
      ({
        gmailAppPassword,
        openrouterApiKey,
        ...safe
      }) => safe
    );

    res.json({ users });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SAVE USER
// ─────────────────────────────────────────────────────────────────────────────

app.post(
  '/api/users',
  (req, res) => {
    try {
      const {
        name,
        email,
        phone,
        linkedin,
        experience,
        skills,
        aiTools,
        strengths,
        availability,
        cvFile,
        color,
        gmailAppPassword,
        openrouterApiKey,
      } = req.body;

      if (
        !name?.trim() ||
        !email?.trim() ||
        !phone?.trim() ||
        !experience?.trim() ||
        !skills?.trim()
      ) {
        return res.status(400).json({
          error:
            'Please fill in all required fields (Name, Email, Phone, Experience, Skills).',
        });
      }

      let finalCvFile =
        cvFile?.trim() || '';

      if (
        req.body.cvBase64 &&
        req.body.cvFileName
      ) {
        const cvDir =
          path.resolve(
            __dirname,
            'public',
            'cvs'
          );

        if (
          !fs.existsSync(cvDir)
        ) {
          fs.mkdirSync(
            cvDir,
            {
              recursive: true,
            }
          );
        }

        const cleanFileName =
          req.body.cvFileName.replace(
            /[^a-zA-Z0-9._-]/g,
            '_'
          );

        const base64Data =
          req.body.cvBase64.replace(
            /^data:[^;]+;base64,/,
            ''
          );

        fs.writeFileSync(
          path.join(
            cvDir,
            cleanFileName
          ),
          Buffer.from(
            base64Data,
            'base64'
          )
        );

        finalCvFile =
          cleanFileName;
      }

      const users =
        loadUsers();

      const id =
        req.body.id?.trim() ||
        name
          .trim()
          .toLowerCase()
          .replace(
            /[^a-z0-9]/g,
            ''
          );

      const initials =
        req.body.initials?.trim() ||
        name
          .trim()
          .split(/\s+/)
          .map(
            word => word[0]
          )
          .join('')
          .slice(0, 3)
          .toUpperCase();

      const userEntry = {
        id,
        name: name.trim(),
        initials,
        email: email.trim(),
        phone:
          phone?.trim() || '',
        linkedin:
          linkedin?.trim() || '',
        experience:
          experience?.trim() || '',
        skills:
          skills?.trim() || '',
        aiTools:
          aiTools?.trim() || '',
        strengths:
          strengths?.trim() || '',
        availability:
          availability?.trim() ||
          'Immediately available',
        cvFile:
          finalCvFile,
        color:
          color?.trim() ||
          '#00f3ff',

        /*
         * Optional BYOK.
         *
         * Normally leave this empty and use
         * OPENROUTER_API_KEY from .env.
         */
        ...(openrouterApiKey?.trim()
          ? {
            openrouterApiKey:
              openrouterApiKey.trim(),
          }
          : {}),
      };

      const existingIndex =
        users.findIndex(
          u => u.id === id
        );

      if (
        existingIndex >= 0
      ) {
        users[existingIndex] = {
          ...users[
          existingIndex
          ],
          ...userEntry,
        };
      } else {
        users.push(
          userEntry
        );
      }

      fs.writeFileSync(
        USERS_LOCAL_PATH,
        JSON.stringify(
          users,
          null,
          2
        )
      );

      /*
       * Keep Gmail credentials in .env.
       */
      if (
        gmailAppPassword?.trim()
      ) {
        const cleanId =
          id
            .replace(
              /[^a-zA-Z0-9]/g,
              '_'
            )
            .toUpperCase();

        const envKey =
          `GMAIL_APP_PASSWORD_${cleanId}`;

        process.env[
          envKey
        ] =
          gmailAppPassword.trim();

        const envPath =
          path.resolve(
            __dirname,
            '.env'
          );

        let envContent =
          fs.existsSync(
            envPath
          )
            ? fs.readFileSync(
              envPath,
              'utf-8'
            )
            : '';

        const regex =
          new RegExp(
            `^${envKey}=.*`,
            'm'
          );

        if (
          regex.test(
            envContent
          )
        ) {
          envContent =
            envContent.replace(
              regex,
              `${envKey}=${gmailAppPassword.trim()}`
            );
        } else {
          envContent =
            envContent.trimEnd() +
            `\n${envKey}=${gmailAppPassword.trim()}\n`;
        }

        fs.writeFileSync(
          envPath,
          envContent
        );
      }

      res.json({
        success: true,
        user: userEntry,
      });
    } catch (error) {
      console.error(
        'Save user error:',
        error.message
      );

      res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE → RAW JOB TEXT
// ─────────────────────────────────────────────────────────────────────────────

app.post(
  '/api/extract-image',
  async (req, res) => {
    try {
      const {
        imageData,
        mimeType,
        userId,
      } = req.body;

      if (!imageData) {
        return res.status(400).json({
          error:
            'No image data provided.',
        });
      }

      const user =
        userId
          ? getUser(userId)
          : null;

      const apiKey =
        resolveOpenRouterApiKey(
          req,
          user
        );

      if (!apiKey) {
        return res.status(400).json({
          error:
            'OpenRouter API key is not configured. Add OPENROUTER_API_KEY to .env.',
        });
      }

      console.log(
        '[Job Image] Extracting job text with vision model...'
      );

      const result = await generateFromImage(
        imageData,
        mimeType || 'image/png',
        buildImageExtractionPrompt(),
        apiKey
      );

      res.json({
        text: String(result).trim(),
      });
    } catch (error) {
      console.error(
        'Image extraction error:',
        error
      );

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Failed to extract job posting from image.',
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// JOB TEXT → EMAIL
// ─────────────────────────────────────────────────────────────────────────────

app.post(
  '/api/generate',
  async (req, res) => {
    try {
      const {
        jobPost,
        userId,
      } = req.body;

      if (!jobPost?.trim()) {
        return res.status(400).json({
          error:
            'Job post text is required.',
        });
      }

      const user =
        getUser(userId);

      if (!user) {
        return res.status(400).json({
          error:
            'User profile not found.',
        });
      }

      const apiKey =
        resolveOpenRouterApiKey(
          req,
          user
        );

      if (!apiKey) {
        return res.status(400).json({
          error:
            'OpenRouter API key is not configured. Add OPENROUTER_API_KEY to .env.',
        });
      }

      /*
       * IMPORTANT:
       *
       * This parsing is local/deterministic.
       * No LLM call is needed here.
       */
      const parsed =
        parseJobPost(
          jobPost
        );

      const prompt =
        buildEmailPrompt(
          jobPost,
          user
        );

      console.log(
        '[Email] Generating with OpenRouter...'
      );

      const result = await generateText(
        buildEmailPrompt(jobPost, user),
        apiKey,
        { json: true }
      );

      const generated = parseJsonResponse(result);

      const signature = [
        '**Best regards,**',
        `**${user.name || ''}**`,
        `**${user.phone || ''}**`,
        `**Linkedin : ${user.linkedin || ''}**`
      ].join('\n');

      let body = generated.body.trim();

      if (!body.includes('**Best regards,**')) {
        body = `${body}\n\n${signature}`;
      }

      generated.body = body;

      if (
        !generated.subject ||
        !generated.body
      ) {
        throw new Error(
          'LLM response did not contain subject/body.'
        );
      }

      res.json({
        parsed,
        subject:
          generated.subject,
        body:
          generated.body,
        whatsapp:
          generated.whatsapp ||
          '',
        model:
          result.model,
      });
    } catch (error) {
      console.error(
        'Generate error:',
        error
      );

      res.status(
        error.status || 500
      ).json({
        error:
          error.message ||
          'Failed to generate email.',
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SEND EMAIL
// ─────────────────────────────────────────────────────────────────────────────

app.post(
  '/api/send',
  async (req, res) => {
    try {
      const {
        to,
        subject,
        body,
        userId,
      } = req.body;

      if (
        !to?.length ||
        !subject ||
        !body
      ) {
        return res.status(400).json({
          error:
            'Missing to, subject, or body.',
        });
      }

      const user =
        getUser(userId);

      if (!user) {
        return res.status(400).json({
          error:
            'User profile not found.',
        });
      }

      const transporter =
        createGmailTransporter(
          user
        );

      const attachments =
        getCvAttachment(
          user
        );

      const recipients =
        Array.isArray(to)
          ? to.join(', ')
          : to;

      const info =
        await transporter.sendMail(
          {
            from: `"${user.name}" <${user.email}>`,
            to: recipients,
            subject,
            text:
              body.replace(
                /\*\*/g,
                ''
              ),
            html:
              `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;">${formatEmailHtml(body)}</div>`,
            attachments,
          }
        );

      const entry = {
        id:
          crypto.randomUUID(),
        userId:
          user.id,
        userName:
          user.name,
        to: recipients,
        subject,
        body,
        messageId:
          info.messageId,
        timestamp:
          new Date().toISOString(),
        followedUp:
          false,
        followUpTime:
          null,
      };

      const sent =
        loadSent();

      sent.unshift(
        entry
      );

      saveSent(
        sent
      );

      res.json({
        success: true,
        message:
          `Email sent to ${recipients}`,
        entry,
      });
    } catch (error) {
      console.error(
        'Send error:',
        error.message
      );

      res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UP
// ─────────────────────────────────────────────────────────────────────────────

app.post(
  '/api/followup',
  async (req, res) => {
    try {
      const { id } =
        req.body;

      const sent =
        loadSent();

      const original =
        sent.find(
          entry =>
            entry.id === id
        );

      if (!original) {
        return res.status(404).json({
          error:
            'Original email not found.',
        });
      }

      if (
        original.followedUp
      ) {
        return res.status(400).json({
          error:
            'Already followed up on this email.',
        });
      }

      const user =
        getUser(
          original.userId
        );

      if (!user) {
        return res.status(400).json({
          error:
            'User profile not found.',
        });
      }

      const apiKey =
        resolveOpenRouterApiKey(
          req,
          user
        );

      if (!apiKey) {
        return res.status(400).json({
          error:
            'OpenRouter API key is not configured.',
        });
      }

      const prompt =
        buildFollowUpPrompt(
          original,
          user
        );

      const result =
        await generateText({
          apiKey,
          messages: [
            {
              role: 'user',
              content:
                prompt,
            },
          ],
          maxTokens: 300,
          temperature: 0.5,
        });

      const followUpBody =
        result.text.trim();

      const transporter =
        createGmailTransporter(
          user
        );

      const attachments =
        getCvAttachment(
          user
        );

      await transporter.sendMail(
        {
          from: `"${user.name}" <${user.email}>`,
          to: original.to,
          subject:
            `Re: ${original.subject}`,
          text:
            followUpBody.replace(
              /\*\*/g,
              ''
            ),
          html:
            `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;">${formatEmailHtml(followUpBody)}</div>`,
          inReplyTo:
            original.messageId,
          references:
            original.messageId,
          attachments,
        }
      );

      original.followedUp =
        true;

      original.followUpTime =
        new Date().toISOString();

      original.followUpBody =
        followUpBody;

      saveSent(
        sent
      );

      res.json({
        success: true,
        body:
          followUpBody,
        to:
          original.to,
      });
    } catch (error) {
      console.error(
        'Follow-up error:',
        error.message
      );

      res.status(
        error.status || 500
      ).json({
        error:
          error.message,
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL LOG
// ─────────────────────────────────────────────────────────────────────────────

app.get(
  '/api/log',
  (req, res) => {
    res.set(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, private'
    );

    const {
      userId,
    } = req.query;

    let entries =
      loadSent();

    if (userId) {
      const defaultUserId =
        loadUsers()[0]?.id;

      entries =
        entries.filter(
          entry =>
            entry.userId ===
            userId ||
            (
              !entry.userId &&
              userId ===
              defaultUserId
            )
        );
    }

    res.json({
      entries:
        entries.slice(
          0,
          50
        ),
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────

app.listen(
  PORT,
  () => {
    console.log(
      `\n🚀 Emailer running → http://localhost:${PORT}\n`
    );

    console.log('[AI] Provider chain: Groq → Gemini → OpenRouter/free');
  }
);