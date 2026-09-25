/**
 * ================================================================
 * AI APPLICATION PROMPTS
 * ================================================================
 *
 * This file contains the prompts used for:
 *
 * 1. Job-posting image extraction
 * 2. Job application email generation
 * 3. WhatsApp message generation
 * 4. Follow-up email generation
 *
 * PROMPT PRIORITY
 * ---------------
 *
 * 1. Explicit instructions in the job posting
 * 2. Candidate profile facts
 * 3. Personal writing preferences
 * 4. Default email format
 *
 * Employer-specific application instructions ALWAYS override the
 * application's default email structure.
 *
 * ================================================================
 */


/**
 * ================================================================
 * HUMAN WRITING / QUALITY RULES
 * ================================================================
 */

const HUMAN_IN_THE_LOOP = `
QUALITY CHECK:

- Write like a real professional, not an AI.
- Be natural, concise, and conversational.
- Remove generic AI phrases.
- Remove repetition.
- Avoid unnecessary formality.
- Avoid exaggerated claims.
- Do not use em dashes (—).
- Never invent experience, skills, companies, achievements,
  qualifications, salary, notice period, or other candidate data.
- Use only facts provided in the candidate profile or job posting.
`;


/**
 * ================================================================
 * IMAGE EXTRACTION PROMPT
 * ================================================================
 */

function buildImageExtractionPrompt() {
  return `
Extract the complete job posting text from this image.

Return ONLY the text of the job posting.

Preserve as much information as possible, including:

- Company name
- Job title
- Responsibilities
- Technical requirements
- Experience requirements
- Location
- Employment type
- Salary
- Recruiter/hiring-person name
- Contact email
- Contact phone
- Application instructions
- Required candidate details
- Required subject format
- Required email format
- Required keywords
- URLs

IMPORTANT:

Preserve application instructions exactly.

If the posting contains a structured block such as:

WITH
Total Exp:
Rel Exp:
CCTC:
ECTC:
Notice period:
Current Location:
Preferred Location:

preserve that entire block.

Do not summarize.
Do not interpret.
Do not add commentary.
Do not remove application instructions.

If some text is unclear, make the best possible transcription
without inventing information.
`;
}


/**
 * ================================================================
 * EMAIL GENERATION PROMPT
 * ================================================================
 */

function buildEmailPrompt(jobPost, user) {
  const profile = `
Candidate:
Name: ${user.name || ''}
Email: ${user.email || ''}
Phone: ${user.phone || ''}
LinkedIn: ${user.linkedin || ''}
Experience: ${user.experience || ''}
Core Skills: ${user.skills || ''}
AI Tools: ${user.aiTools || 'N/A'}
Strengths: ${user.strengths || ''}
Availability: ${user.availability || 'Immediately available'}
`;

  return `
You are writing a professional job application on behalf of
the candidate.

CANDIDATE PROFILE:
${profile}

JOB POSTING:
${jobPost}

Generate:

1. Email subject
2. Email body
3. Short WhatsApp message

${HUMAN_IN_THE_LOOP}


===============================================================
STEP 1 — EMPLOYER-SPECIFIC APPLICATION INSTRUCTIONS
===============================================================

Inspect the ENTIRE job posting before writing anything.

Employer instructions have the HIGHEST PRIORITY.

Look for:

- Required subject formats
- Required subject keywords
- Required candidate details
- Required fields
- Application templates
- Specific email formats
- Specific ordering of information
- "Send the following details"
- "Mention the following"
- "Email with"
- "Share your profile in the following format"
- A block containing field names followed by colons

A block such as:

WITH
Total Exp:
Rel Exp:
CCTC:
ECTC:
Notice period:
Current Location:
Preferred Location:

is an EXPLICIT APPLICATION TEMPLATE.

It is NOT optional.

If such a template exists, it MUST become the primary structure
of the email body.


===============================================================
STEP 2 — EMPLOYER FORMAT OVERRIDES DEFAULT FORMAT
===============================================================

IF the job posting specifies an application format:

- Follow the employer's format.
- Preserve every requested field.
- Preserve the exact field names.
- Preserve the requested field order.
- Do not omit any requested field.
- Do not convert the fields into unrelated bullet points.
- Do not replace the employer format with the default email.
- Do not add unnecessary paragraphs before the requested fields.
- A short greeting is allowed when appropriate.
- Keep the application concise.

MOST IMPORTANT RULE:

EXPLICIT EMPLOYER APPLICATION FORMAT
>
DEFAULT EMAIL FORMAT


===============================================================
STEP 3 — MISSING VALUES MUST BE "NA"
===============================================================

If the employer requests a field and the candidate profile does
not contain a value, use exactly:

NA

Example:

Total Exp: 7+ years
Rel Exp: NA
CCTC: NA
ECTC: NA
Notice period: Immediately available
Current Location: NA
Preferred Location: NA

NEVER:

- Guess.
- Estimate.
- Infer.
- Invent.
- Leave the field blank.
- Remove the field.

The user will manually replace NA before sending.

This applies to ANY recruiter-requested field, including:

- Total Exp
- Rel Exp
- CCTC
- ECTC
- Notice period
- Current Location
- Preferred Location
- Salary
- Education
- Certifications
- Any other requested candidate information.


===============================================================
STEP 4 — SUBJECT
===============================================================

FIRST determine whether the employer specifies a subject format.

IF YES:

- Follow it exactly.
- Replace placeholders only with information actually available.
- If required information is unavailable, use NA.
- Do not use the default subject format.

IF NO:

Use:

[Exact Role] | [Experience]

Example:

AI Full Stack Engineer | 7+ years Experience

Mention "Immediately Available" in the subject ONLY when:

- the job posting specifically asks for it, OR
- the application instructions clearly require availability
  in the subject.

Otherwise do not add it.

IMPORTANT:

- The email body must be complete.
- Never stop mid-sentence or mid-paragraph.
- Keep the email concise enough to fit within the output limit.
- The application will append the final signature separately.
- Do not generate the signature.


===============================================================
STEP 5 — DEFAULT EMAIL FORMAT
===============================================================

ONLY use this when the employer does NOT specify an application
format.

Greeting:

- Use "Hi [Recruiter/Hiring Person Name]," when a name is clearly
  available.
- Otherwise use "Hi Hiring Team,"

Opening:

- Express interest in the role in ONE sentence.

Body:

- MOST IMPOTANTLY Use 3-4 short bullet points.
- DO NOT USE LONG SENTENCES!
- ALWAYS START EACH POINT FROM A NEW LINE!
- Highlight skills that directly match the job.
- Use **bold** around important technical keywords.
- Keep bullets concise.
- Do not repeat the job description.
- Do not keyword-stuff.

Closing:

- Mention availability/location only when relevant.
- Keep the closing short.

End EXACTLY with:

Do NOT generate a signature.
The application will append the signature separately.


===============================================================
STEP 6 — FACTUAL ACCURACY
===============================================================

Only use information supplied in the candidate profile.

NEVER invent:

- Experience
- Relevant experience
- CCTC
- ECTC
- Notice period
- Current location
- Preferred location
- Skills
- Technologies
- Companies
- Achievements
- Education
- Certifications
- Projects
- Responsibilities
- Salary information

If a requested field is unavailable:

NA

The candidate profile and job posting are the only sources of
truth.


===============================================================
STEP 7 — SKILL MATCHING
===============================================================

When using the default email format:

- Highlight only genuine matches.
- Prioritize skills explicitly present in the candidate profile.
- Do not claim experience with a technology merely because it
  appears in the job description.
- Do not keyword-stuff.
- Use **bold** for important technical keywords.
- Do not repeat the job description.


===============================================================
STEP 8 — WHATSAPP MESSAGE
===============================================================

Create a separate short WhatsApp message.

Rules:

- Maximum 5-6 lines.
- Friendly, casual, and professional.
- Start directly.

Example:

Hi, I saw your post for [Role]...

- Mention the specific role.
- Mention 2-3 genuinely relevant skills.
- Mention availability when appropriate.
- Do not copy the entire email.
- Do not use unnecessary formal language.
- Do not use the employer's email template in WhatsApp unless
  the posting explicitly requires the same format for WhatsApp.

End with:

${user.name || ''} | ${user.phone || ''} | ${(user.linkedin || '').replace('https://', '')}


===============================================================
STEP 9 — FINAL CONTENT VALIDATION
===============================================================

Before producing the final response:

1. Did the job posting specify an application format?

IF YES:
- Use that format.
- Preserve every requested field.
- Preserve field order.
- Fill unavailable values with NA.
- Do not use the default email format.

IF NO:
- Use the default email format.

2. Did the job posting specify a subject format?

IF YES:
- Follow it exactly.

IF NO:
- Use the default subject format.

3. Did you invent candidate information?

IF YES:
- Remove it.
- Use NA where the employer requested the missing field.

4. Is the email concise and natural?

5. Is the signature exactly correct?


===============================================================
STEP 10 — STRUCTURED OUTPUT CONTRACT
===============================================================

This application parses your response using JSON.parse().

Therefore the final response MUST be machine-readable JSON.

Return ONLY a raw JSON object.

DO NOT:

- Use Markdown.
- Use a JSON code fence.
- Use Markdown code fences.
- Add explanations before the JSON.
- Add explanations after the JSON.
- Return an array.
- Return multiple JSON objects.
- Add comments inside the JSON.
- Use trailing commas.

The response MUST contain exactly these top-level fields:

{
  "subject": "string",
  "body": "string",
  "whatsapp": "string"
}

All three values MUST be strings.

The JSON MUST be syntactically valid and directly parseable
using JSON.parse().

FINAL OUTPUT:

{
  "subject": "...",
  "body": "...",
  "whatsapp": "..."
}
`;
}


/**
 * ================================================================
 * FOLLOW-UP PROMPT
 * ================================================================
 */

function buildFollowUpPrompt(original, user) {
  return `
Write a very short professional follow-up email for a previous
job application.

Original subject:
${original.subject}

Sent to:
${original.to}

Candidate:
Name: ${user.name || ''}
Phone: ${user.phone || ''}
LinkedIn: ${user.linkedin || ''}

RULES:

- 1-2 short sentences maximum.
- Politely ask them to review the profile/application.
- Friendly and non-pushy.
- Do not repeat the original application.
- Do not introduce new claims.
- Do not sound AI-generated.
- Do not use an em dash.
- End EXACTLY with:

Best regards,
${user.name || ''}
Phone : ${user.phone || ''}
Linkedin : ${user.linkedin || ''}

${HUMAN_IN_THE_LOOP}

Return ONLY the email body.
`;
}


module.exports = {
  buildImageExtractionPrompt,
  buildEmailPrompt,
  buildFollowUpPrompt,
};