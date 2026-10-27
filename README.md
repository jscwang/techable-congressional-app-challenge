# Techable QA review source

This is the application source for the tested separate QA preview, prepared for GitHub handoff on October 27, 2026. It does not contain Dev1's original checkout, Git history, API keys, account passwords, database exports or user-uploaded media. No repository or live deployment was changed by preparing this ZIP.

Review website: https://techable-review-techable.vercel.app/index.html#signin

## Upload to GitHub

1. Extract this ZIP. Upload the contents of this folder into a new review branch or separate repository. Keep Dev1's original branch/version intact.
2. Include the source subfolders, especially `api/` and `assets/`, plus the root HTML/JS/MJS/CSS files and Firebase rules/configuration.
3. Keep `.gitignore` and `.vercelignore`. `.env.example` contains blank placeholders only; keep actual credentials in server environment settings.
4. This package provides app source, not an authorship or license statement. Confirm student contributions, attribution and the chosen license before making a competition repository public.

## Hosting

The app uses hand-written HTML and JavaScript, Firebase Authentication/Firestore, and Vercel serverless functions. There is intentionally no root package.json and no framework build step. GitHub can hold the source, but GitHub Pages alone cannot run the `api/` functions needed for AI and transcription.

The existing QA review deployment is already configured. Uploading source does not copy its environment settings, Firebase users, data, rules publication or OAuth configuration to another deployment.

For a separate deployment, use a separate QA Vercel project and configure the variables in `.env.example` with its own approved settings. Keep private values server-side. Set ALLOWED_ORIGINS to the intended application origin. Firebase Authentication needs the intended login providers and authorized domain, and Google sign-in needs the matching callback configuration. Do not change production while setting up a review deployment.

`vercel.json` is the exact tested QA configuration and includes the same-origin `/__/auth/` proxy to `techable-qa.firebaseapp.com`. If using a different Firebase project, adapt that QA proxy as well. Firebase rules/indexes are included as source; they do not publish themselves. Review and deploy only to the intended QA project.

The restricted Dev2 dual-workspace support is specific to the existing QA identity and its protected admin-granted profile field. It does not create credentials or grant another account access. Ordinary accounts retain their own module roles.

## Tested functionality

- Four role entrances; Dev2 Google access to Senior Center and Service Provider in QA.
- Senior mood guessing game, AI/voice input, personal blog and center/provider directory.
- Center connections, attendance, news, member announcements and reviewed forms.
- Family chat, reviewed story/photo/video captions and linked-senior AI updates.
- Benefits/transport links and the fictional Healthfirst-example voice form.
- Provider clickable applicant/member details and private targeted member announcements.

Latest provider feature passed the full local regression suite, 432 Firestore permission checks, and actual QA application approval, private delivery, persisted inbox and unrelated-account denial checks. This ZIP contains the app/security source, not the private development audit/test workspace.

## Current limits

Real verification-document upload and admin review still need isolated private QA storage and reviewer configuration. The insurance form is a demonstration: it does not submit an application. OMNY is an official external sign-in link, not Techable voice authentication or ticket purchasing. Multi-field extraction from one spoken form answer is not yet implemented. Donation was removed at Annie's request. This handoff does not establish HIPAA compliance or a completed production release.
