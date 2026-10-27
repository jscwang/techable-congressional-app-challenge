// ============================================================
// i18n.js — language packs for the daily check-in ("Guess My Day")
//
// The check-in is the one part of the app that talks to the senior directly,
// out loud, in scripted sentences. Everything it can say lives here so it can
// be said in the language the person actually thinks in — English, Mandarin,
// or Cantonese — without checkin.js growing three copies of its flow.
//
// Loaded before app.js and checkin.js, so both can read window.TechableI18n.
//
// Three things travel together for each language, and all three have to match
// or the check-in half-works:
//   1. what Techable SAYS      — the strings below
//   2. what Techable HEARS     — `speech`, the recogniser's language code
//   3. what Techable UNDERSTANDS — `patterns`, the regexes that read an answer
//
// Notes that cost us something to learn:
//
// • Cantonese is not "Chinese". Ask any speech or text service for Chinese and
//   you get Mandarin grammar in standard written Chinese, which a Cantonese
//   speaker hears as a newsreader, not a friend. Every Cantonese string here is
//   written the way it is spoken (係/唔/嘅/咗/喺/佢), and the recogniser is asked
//   for yue-Hant-HK with zh-HK as the fallback.
//
// • Negation has to be tested before the word it negates, in every language.
//   "not feeling good" contains "good"; 唔好 contains 好; 不太好 contains 好.
//   Pattern order in each pack is load-bearing — see MOOD ORDER below.
//
// • What the senior HEARS is translated. What the care team READS is not: the
//   stored record keeps English labels and summaries so one dashboard still
//   works for a centre whose residents speak three different languages. That
//   is what en() is for.
// ============================================================

;(function () {
  'use strict'

  // ── Languages ─────────────────────────────────────────────────
  // `speech` is what SpeechRecognition is asked for; `speechAlt` are tried
  // after it, because browser support for the Cantonese tag is patchy and
  // zh-HK is the widely accepted stand-in. `voice` matches an installed
  // speech-synthesis voice.
  const LANGS = [
    {
      code: 'en', label: 'English', native: 'English', flag: '🇬🇧',
      speech: 'en-US', speechAlt: ['en-GB'],
      voice: /^en([-_]|$)/i
    },
    {
      code: 'cmn', label: 'Mandarin', native: '普通話', flag: '🇨🇳',
      speech: 'zh-CN', speechAlt: ['cmn-Hans-CN', 'zh'],
      voice: /^(cmn|zh)([-_](cn|hans|sg))?$/i,
      voiceFallback: /^(cmn|zh)([-_]|$)/i
    },
    {
      code: 'yue', label: 'Cantonese', native: '廣東話', flag: '🇭🇰',
      speech: 'yue-Hant-HK', speechAlt: ['zh-HK', 'zh-yue'],
      voice: /^(yue|zh[-_]hk|zh[-_]hant[-_]hk)/i,
      // Last resort only. Most Windows and Android devices ship no Cantonese
      // voice at all, so without this the check-in goes silent on them. A
      // Mandarin voice reading Cantonese is wrong — the tones and several
      // words differ — but the characters are Chinese and it is understood,
      // where an English voice attempting 你食咗飯未 is not speech at all.
      // /api/tts is the real answer; this keeps the offline path usable.
      voiceFallback: /^(yue|zh|cmn)([-_]|$)/i
    }
  ]

  const BY_CODE = Object.fromEntries(LANGS.map(l => [l.code, l]))
  const STORE_KEY = 'techable_lang'

  // ── English ───────────────────────────────────────────────────
  // The reference pack. Every other pack falls back to this key by key, so a
  // missing translation degrades to English rather than to a blank prompt.
  const en = {
    // Moods. The keys ('good' / 'okay' / 'low' / 'tired') are storage values
    // and never change; only these labels do.
    'mood.good':  'Happy',
    'mood.okay':  'Okay',
    'mood.low':   'Not So Good',
    'mood.tired': 'Tired',

    // The first thing said when a conversation is opened and the check-in is
    // not the thing opening it — after today's check-in is already done, or
    // when the senior starts a new chat themselves.
    //
    // Written as functions rather than plain strings because a resident record
    // without a name is normal (a manager can create one from a room number),
    // and "Good morning, {name}." with the placeholder still in it is what a
    // plain string with no value would produce. t() already supports this.
    'greet.morning':   ({ name }) => (name ? `Good morning, ${name}.`   : 'Good morning.'),
    'greet.afternoon': ({ name }) => (name ? `Good afternoon, ${name}.` : 'Good afternoon.'),
    'greet.evening':   ({ name }) => (name ? `Good evening, ${name}.`   : 'Good evening.'),
    'greet.opener':    'It is good to hear from you. What would you like to talk about today?',

    // Opening and the mood question
    'open.voice':      'Hello {name}. How are you feeling today?',
    // Spoken as one utterance with 'ask.mood' immediately after it, so it
    // leads into that question rather than asking one of its own.
    'open.buttons':    'Hello {name}. Let me see if I can guess how today has been for you.',
    'ask.mood':        'How are you feeling today?',
    'ask.mood.retry':  'I did not quite catch that. Would you say today has been a good day, an alright day, or not so good?',

    // "Okay" is neither good nor bad, so it gets its own question instead of a
    // guess that has to assume one or the other.
    'ask.lean':        'Okay can mean all sorts of things. Would you say today has leaned more towards a good day, or more towards a hard one?',
    'lean.positive':   'More good',
    'lean.neutral':    'Just an ordinary day',
    'lean.negative':   'More of a hard one',

    // Answers to a guess ("Is it because…?") and to a plain question.
    'answer.yes':   'Yes',
    'answer.close': 'Not quite',
    'answer.no':    'Try again',
    'answer.q.yes':   'Yes',
    'answer.q.close': 'Not sure',
    'answer.q.no':    'No',
    'ask.yesno.retry': 'Sorry, was that a yes or a no?',
    'guess.progress': 'Guess {number} of {total}.',
    'guess.question.progress': 'Question {number} of {total}.',

    // Opening the floor
    'ask.more':          'Thank you for telling me. Would you like to say a little more about that?',
    'close.q':           'Would you like to tell me any more?',
    'close.more':        'Tell you more',
    'close.done':        'That is all',
    'open.listening':    'I am listening. What would you like to tell me?',
    'open.noguess':      'I could not guess it today. What is on your mind?',
    'open.nothing':      'Tell me what is on your mind today.',
    'open.outofguesses': 'I have run out of guesses — you win. Would you tell me what it is?',
    'wait':              'One moment…',

    // Ending
    'finish.bye':    'Thank you, {name}. I will check in with you again tomorrow.',
    'finish.prompt': 'Thank you for checking in today.',
    'finish.btn':    'Finish',

    // Escalation. Deliberately plain and unhurried — this is read aloud to
    // someone who has just disclosed something frightening.
    // These said "I am letting your care team know straight away" and "I am
    // passing this on now" — and nothing was sent to anybody. The app writes a
    // record; a person sees it when they next open a dashboard. Telling someone
    // who has just disclosed a fall that help is on its way, when it is not, is
    // the worst thing in this file to get wrong: it is exactly the moment they
    // might otherwise ring somebody themselves.
    //
    // So the promise is now the one the app can keep — it has written this down
    // for their care team — and the line that actually gets help is given the
    // last word in both cases rather than only in the emergency one.
    'esc.emergency': 'Thank you for telling me. This sounds important and I want a person to help you. I have written this down for your care team to see. If you need help now, please call your emergency number, or someone nearby.',
    'esc.urgent':    'Thank you for telling me. I have written this down so someone from your care team can see it and help you properly. If it cannot wait, please tell someone near you, or call them yourself.',
    'esc.prompt':    'Getting help for you',
    'esc.title':     '⚠️ Written down for your care team',
    'esc.body':      'This check-in was stopped and saved for your care team to see. If it cannot wait, please contact them yourself.',
    'esc.body.emergency': 'This check-in was stopped and saved for your care team to see. If this is an emergency, call your local emergency number now — do not wait for someone to read this.',
    'esc.close':     'Close',

    // Offline closing replies, used when the model is unreachable.
    'fallback.discomfort': 'Thank you for telling me, {name}. That sounds uncomfortable — do let someone close to you know about it. Is there anything that helps when it feels like this?',
    'fallback.loneliness': 'Thank you for sharing that, {name}. Quiet days can feel long — and you can always talk with me when they do. What would you like to talk about?',
    'fallback.good':       'That is lovely to hear, {name}. What was the best part of your day?',
    'fallback.default':    'Thank you for telling me, {name}. I am glad you shared that with me. What would make tomorrow a little better?',

    // Dashboard card and panel furniture
    'card.title':  '☀️ Today\'s Check-In',
    'card.sub':    'A short daily chat about how you feel',
    'card.invite': 'Techable would like to hear how your day is going.',
    'card.start':  '💬 Start today\'s chat',
    'card.note':   'It opens in the chat and takes a minute or two. You can stop any time.',
    'ui.repeat':   'Repeat',
    'ui.stop':     'Stop',
    'ui.send':     'Send',
    'ui.ready':    'Getting ready…',
    'ui.placeholder': 'You can type here, or tap the microphone and just talk…',
    'ui.answer':   'Your answer',
    'ui.mic.start': 'Speak your answer',
    'ui.mic.stop':  'Stop speaking and send your answer',

    'toast.selectFirst':    'Select an elderly profile first',
    'toast.saved':          'Check-in saved ✓',
    'toast.stopped':        'Check-in stopped',
    'toast.stoppedPartial': 'Check-in stopped — partial answer saved',
    'toast.noSpeech':       'Speech recognition not supported',
    'toast.micBlocked':     'Microphone blocked. Allow it in your browser settings, then tap the microphone again.',
    'toast.micStartFailed': 'Could not start the microphone. Tap the microphone and try again.',
    'toast.speechNetwork':  'Voice typing could not connect to the speech service. Please try again, or type your answer below.',

    // ── The senior's chat screen (F48) ─────────────────────────
    // The controls themselves, not the conversation: the bar at the foot of
    // the screen, the one microphone, the read-aloud switch, Finish for now.
    'nav.chat':     'Chat',
    'nav.memories': 'Memories',
    'nav.history':  'Past Chats',
    'nav.about':    'About Me',
    'hub.title':    'About me',
    'hub.memories': 'Things I remember about you',
    'hub.history':  'Past chats',
    'hub.forms':    'Forms & benefits',
    'hub.centres':  'Centres & news',
    'hub.help':     'Help & questions',
    'hub.logout':   'Log out',
    'hub.back':     'Back to About me',
    'talk.idle':           'Tap to talk',
    'talk.ready':          'Getting ready…',
    'talk.listening':      'Listening… tap when done',
    'talk.ready.aria':     'Getting ready to listen',
    'talk.listening.aria': 'Listening — tap to stop and send',
    'chat.placeholder':    'Or type a message here…',
    'aloud.label':     'Read replies aloud:',
    'aloud.on':        'On',
    'aloud.off':       'Off',
    'aloud.toast.on':  'Replies will be read aloud 🔊',
    'aloud.toast.off': 'Replies will not be read aloud 🔇',
    'chat.finish':  'Finish for now',
    'chat.bye':     'Thank you for the chat, {name}. I am here whenever you would like to talk again.',
    'chat.ended':   'This chat is finished.',
    'chat.again':   '💬 Start a new chat',

    // ── The conversation (F46) ───────────────────────────────────
    // The day's mood game is offered by the greeting rather than started on
    // the senior's behalf, and every answer — a "no" included — is heard.
    'greet.offer':     'It is good to hear from you. Would you like to play today\'s mood game, or shall we just chat?',
    'ask.mood.game':   'Lovely! How are you feeling today?',
    'offer.declined':  'Of course. We can just chat — tell me anything you like.',
    'ack.mood.good':   'That is lovely to hear.',
    'ack.mood.okay':   'Thank you for telling me.',
    'ack.mood.low':    'I am sorry you are not feeling so good today.',
    'ack.mood.tired':  'Oh dear, a tired day.',
    'ack.lean.positive': 'Mostly a good day, then.',
    'ack.lean.neutral':  'An ordinary sort of day, then.',
    'ack.lean.negative': 'I am sorry it has been a harder one.',
    'ack.miss':        'Not that, then.',
    'ack.close':       'A little, then.',
    'ack.declined':    'That is alright — you do not have to say. Thank you for telling me how you are.',
    'ack.ok':          'That is alright.',

    // Offline replies, used only when the AI cannot be reached. Each names
    // what was said where it can, asks one question at most, and is never
    // used twice in one conversation. {echo} is English only: the clause the
    // senior said, turned round ("your son didn't call you").
    'reply.low.echo':    'I am sorry {echo}. That sounds hard. Would you like to tell me what happened?',
    'reply.low.who':     'I am sorry to hear about your {who}. That sounds hard. What happened?',
    'reply.low.feeling': 'I am sorry you are feeling {feeling}. That is a hard way to feel. What has made it like that?',
    'reply.low.1':       'I am sorry today is not a good one. Would you like to tell me about it?',
    'reply.low.2':       'That sounds like a hard time, and I am sorry. What is weighing on you most?',
    'reply.low.3':       'Thank you for telling me how you really feel. I am here with you. Is there anything that would help a little?',
    'reply.tired.1':     'A tired day is allowed. Have you been able to rest at all?',
    'reply.tired.2':     'Being tired takes the shine off everything. Is there something gentle you could do to rest?',
    'reply.pain':        'I am sorry it hurts. Do mention it to someone close to you. What usually helps when it feels like this?',
    'reply.lonely.1':    'That sounds like a lonely feeling. I am here whenever you want to talk. Who have you been thinking of?',
    'reply.lonely.2':    'I understand how that feels. If there is nobody about, you can always talk with me. What would you like to talk about?',
    'reply.good.echo':   'How lovely that {echo}! What was the best part?',
    'reply.good.who':    'That is lovely to hear about your {who}. What did you do together?',
    'reply.good.1':      'That is lovely to hear. What made it so good?',
    'reply.good.2':      'I am so glad to hear that. What happened?',
    'reply.who':         'Tell me about your {who}. What are they like?',
    'reply.i.1':         'Oh, {echo}. How was that?',
    'reply.i.2':         'So {echo} — would you tell me a little more about that?',
    'reply.i.3':         'It sounds like {echo}. What was that like for you?',
    'reply.remember':    'I would love to hear more about that. What do you remember most clearly?',
    'reply.no.topic':    'That is alright. Would you like to tell me about {topic} instead?',
    'reply.no.plain':    'That is alright — we can talk about anything you like, or simply rest.',
    'reply.offerStop':   'That is quite alright. We do not have to talk now. Shall we leave it there for today?',
    'reply.memory':      'That reminds me of something you told me: “{mem}”. Would you tell me more about it?',
    'reply.open.1':      'What has been on your mind lately?',
    'reply.open.2':      'Is there something you are looking forward to this week?',
    'reply.open.3':      'What is something that made you smile recently?',
    'reply.open.4':      'If you could have any meal right now, what would it be?',
    'reply.open.day':    'What has today been like for you?',
    'reply.rest':        'It has been lovely talking with you. I am here whenever you would like to chat again.',
    'ai.offline':        'I am having a little trouble thinking just now, so my answers may be simpler for a while.',
    'ai.offline.short':  'Simple replies for now',

    // ── Conversation starters (F47) ─────────────────────────────
    // Tiles under the greeting until the senior says something. A tile is a
    // subject; tapping it makes the companion ask about it, so each label
    // reads as a topic and each ask as the companion's own question.
    'starters.title':    'Something to talk about?',
    'starter.game':      'Today\'s mood game',
    'starter.memory':    'You once told me: “{mem}”. Would you tell me more about it?',
    // English only: memories the app learned for itself are saved in English
    // shapes ("Enjoys gardening"), and these turn them into a question. Other
    // languages quote the memory as it was saved, with 'starter.memory'.
    'starter.enjoys':    'You enjoy {what}. What do you love most about it?',
    'starter.grewup':    'You grew up in {place}. What was it like there when you were young?',
    'starter.kin':       'Tell me about your {who}. What do you enjoy doing together?',
    'starter.named':     'Tell me about your {who}, {person}. What is {person} like?',
    'starter.job':       'You used to be {job}. What do you remember most about those days?',
    'starter.open.smile': 'What made you smile',
    'starter.open.meal':  'A favourite meal',
    'starter.open.ahead': 'Plans for the week',
    'starter.open.young': 'When you were young',
    'starter.open.place': 'A place you love',
    'starter.ask.young':  'What is a happy memory from when you were young?',
    'starter.ask.place':  'What is a place you have always loved?',

    // ── The life story book (F49) ────────────────────────────────
    // Chapter keys are storage values and never change. The English headings
    // are also what the family dashboard shows (it reads the same keys).
    'story.ch.childhood': 'Childhood',
    'story.ch.school':    'School days',
    'story.ch.work':      'Work',
    'story.ch.love':      'Love & marriage',
    'story.ch.family':    'Family',
    'story.ch.recipes':   'Recipes',
    'story.ch.places':    'Places & travels',
    'story.ch.lessons':   'Life lessons',
    'story.ch.other':     'Other stories',
    // The same chapters as subjects, on a tile under the greeting.
    'story.topic.childhood': 'Your childhood',
    'story.topic.school':    'Your school days',
    'story.topic.work':      'Your working life',
    'story.topic.love':      'Love and marriage',
    'story.topic.family':    'Your family',
    'story.topic.recipes':   'A dish you are known for',
    'story.topic.places':    'Places you have been',
    'story.topic.lessons':   'What life has taught you',
    'story.topic.other':     'A story from your life',
    // What the companion asks to open each chapter. One question each.
    'story.ask.childhood': 'I would love to hear about your childhood. What is one of your earliest memories?',
    'story.ask.school':    'Tell me about your school days. What was your school like?',
    'story.ask.work':      'Tell me about the work you did. What was your first job?',
    'story.ask.love':      'Tell me about someone you loved. How did you meet?',
    'story.ask.family':    'Tell me about your family. What is a family memory you treasure?',
    'story.ask.recipes':   'Tell me about a dish you are known for. How do you make it?',
    'story.ask.places':    'Tell me about a place that matters to you. What do you remember about being there?',
    'story.ask.lessons':   'What is something life has taught you that you would like others to know?',
    'story.ask.other':     'Is there a story from your life you would like to tell me?',
    // Offline follow-ups while a story is being told: about the same story.
    'story.more.1':  'What else do you remember about that?',
    'story.more.2':  'Who else was there with you?',
    'story.more.3':  'How did it feel at the time?',
    'story.go':      'Please go on — I am listening.',
    'story.saved':   'Thank you for telling me that. I have kept it in your life story, under “{chapter}”.',
    'story.notnow':  'That is alright. We can talk about something else — anything you like.',
    // When the story could not be saved: no claim that it was kept.
    'story.thanks':  'Thank you for telling me that. It was lovely to hear.',
    'story.toast.full':    'Your life story is full. Remove a story in My Story to add a new one.',
    // A long memory from an ordinary chat is only offered, on this device;
    // nothing goes into the book until the senior keeps it.
    'story.suggested':     'That sounded like a story for your life story book. It is waiting in My Story if you would like to keep it.',
    'story.waiting.title': 'Stories from your chats',
    'story.waiting.intro': 'These stay on this device until you choose. Only the ones you keep go into your book, where your centre, linked family and care providers can read them.',
    'story.keep':          'Keep in “{chapter}”',
    'story.dismiss':       'Not this one',
    'story.private':       'Thank you for trusting me with that. I have not put it in your life story book.',
    'story.toast.saved':   'Saved in your life story ✓',
    'story.toast.updated': 'Story updated ✓',
    'story.toast.removed': 'Story removed',
    'story.toast.failed':  'Your story could not be saved just now. Please try again later.',
    // My Story
    'nav.story':      'My Story',
    'story.title':    'My life story',
    'story.intro':    'The stories you tell me, kept in chapters like a book. You can change or remove any of them. Your centre, family you have linked and care providers assigned to you can read them too.',
    'story.print':    'Print or save as PDF',
    'story.tell':     'Talk about it',
    'story.write':    'Write it myself',
    'story.empty':    'No stories yet.',
    'story.edit':     'Change',
    'story.remove':   'Remove',
    'story.save':     'Save',
    'story.cancel':   'Cancel',
    'story.yours':    'Your story',
    'story.chapter':  'Chapter',
    'story.confirmRemove': 'Remove this story from your book?',
    'story.src.story':        'Told to Techable',
    'story.src.conversation': 'From a chat',
    'story.src.manual':       'Written by you',
    'story.book':     ({ name }) => (name ? `The life story of ${name}` : 'My life story'),

    // ── The family inbox (F50) ───────────────────────────────────
    // Messages, voice notes and photos a linked family member sends through
    // family-dashboard.html. Stored for the senior and the sender only;
    // nothing here may suggest anyone was told or notified of anything.
    // {Who} is {who} with a capital letter, for the start of a sentence.
    'nav.family':        'Family',
    'inbox.navLabel':    'Family, {n} new',
    'inbox.title':       'Messages from your family',
    'inbox.intro':       'Messages, voice notes and photos your family send you through Techable. Only you and the person who sent each one can open it here. Once you open one in the chat, it is part of that conversation.',
    // Someone new: nothing they sent is shown until the senior says yes.
    'inbox.ask':          '{name} wants to send you messages.',
    'inbox.ask.relation': 'They say they are your {relation}.',
    'inbox.ask.q':        'Do you know them?',
    'inbox.allow':        'Yes, show their messages',
    'inbox.block':        'No, block them',
    'inbox.allowed':      'Messages from {name} will show here now.',
    'inbox.blocked':      '{name} can no longer send you messages.',
    'inbox.confirmBlock': 'Block {name}? Their messages will be deleted, and they will not be able to send you any more.',
    'inbox.saveFailed':   'That could not be saved just now. Please try again later.',
    'inbox.tapToPlay':    'Tap ▶ to play the voice message.',
    // A family account asking to connect (F32): nothing is shared until yes.
    'link.ask':           '{name} wants to connect to your account.',
    'link.ask.what':      'If you say yes, they can see your profile, summaries of your chats, your daily check-ins and your life story, and send you messages.',
    'link.allow':         'Yes, connect',
    'link.allowed':       '{name} is connected to you now.',
    'link.blocked':       '{name} cannot connect to you or send you messages.',
    'link.confirmBlock':  'Block {name}? They will not be able to connect to you or send you messages.',
    'link.title':         'Connected to you',
    'link.intro':         'These family accounts can see your profile, summaries of your chats, your daily check-ins and your life story.',
    'link.remove':        'Remove',
    'link.confirmRemove': 'Remove {name}? They will no longer see your profile, chats, check-ins or life story.',
    'link.removed':       '{name} is no longer connected to you.',
    'link.loadFailed':    'Who is connected to you could not be checked just now.',
    // "Let my family find me" (F32): whether family can find them by email.
    'find.title':         'Let my family find me',
    'find.intro':         'When this is on, your family can find you by typing your email address in Techable, and ask to connect. You decide on each request.',
    'find.saved.on':      'Your family can find you now.',
    'find.saved.off':     'Nobody can find you by your email address now.',
    'onb.find':           'Let my family find me',
    'onb.find.hint':      'Your family can then find you by your email address and ask to connect. You decide on each request.',
    'inbox.empty':       'No messages yet. When someone in your family sends you a message, a voice note or a photo through Techable, it will be here.',
    'inbox.loading':     'Loading…',
    'inbox.loadFailed':  'Your family messages could not be loaded just now.',
    'inbox.mediaFailed': 'This recording or photo could not be loaded just now.',
    'inbox.new':         'New',
    'inbox.play':        '▶ Play',
    'inbox.show':        '🖼 Show the photo',
    'inbox.read':        '🔊 Read it to me',
    'inbox.delete':      'Delete',
    'inbox.confirmDelete': 'Delete this message? It will be gone for you and for the person who sent it.',
    'inbox.deleted':     'Message deleted',
    'inbox.deleteFailed': 'This message could not be deleted just now.',
    'inbox.who.rel':     'your {relation} {person}',
    'inbox.who.relOnly': 'your {relation}',
    'inbox.who.someone': 'someone in your family',
    'inbox.text.left':   '{Who} left you a message {when}. Would you like to hear it?',
    'inbox.voice.left':  '{Who} left you a voice message {when}. Would you like to hear it?',
    'inbox.photo.left':  '{Who} sent you a photo {when}. Would you like to see it?',
    'inbox.many':        'You have {n} new messages from your family. Would you like to hear them?',
    'inbox.another':     'There is another message, from {who}. Would you like to hear it?',
    'inbox.later':       'Of course. It will be waiting under Family whenever you want it.',
    'inbox.says':        '{Who} says: “{text}”',
    'inbox.voice.here':  'Here is the voice message from {who}.',
    'inbox.photo.here':  'Here is the photo from {who}.',
    'inbox.caption':     'It says: “{text}”',
    'inbox.caption.by':  '{person} wrote: “{text}”',
    'inbox.photoAlt':    'Photo from {who}',
    'starter.family':      'A message from {person}',
    'starter.family.many': '{n} messages from your family',
    'when.morning':   'this morning',
    'when.afternoon': 'this afternoon',
    'when.evening':   'this evening',
    'when.yesterday': 'yesterday',
    'when.day':       'on {day}',
    'when.recent':    'recently',
    'rel.daughter': 'daughter', 'rel.son': 'son', 'rel.granddaughter': 'granddaughter', 'rel.grandson': 'grandson',
    'rel.grandchild': 'grandchild', 'rel.wife': 'wife', 'rel.husband': 'husband', 'rel.partner': 'partner',
    'rel.sister': 'sister', 'rel.brother': 'brother', 'rel.niece': 'niece', 'rel.nephew': 'nephew',
    'rel.cousin': 'cousin', 'rel.friend': 'friend', 'rel.neighbour': 'neighbour', 'rel.carer': 'carer',

    // ── The first visit (F45) ────────────────────────────────────
    // Language, what to call them, what they enjoy, their family, their
    // community centre, how the app works. Every step can be skipped.
    // `.mem` is what is kept in their memories; `.topic` is how the first
    // greeting names it.
    'onb.welcome':    'Welcome to Techable. I am your companion, and I would like to get to know you. It takes about a minute, and you can skip anything.',
    'onb.step':       'Step {n} of {total}',
    'onb.skipAll':    'Skip for now',
    'onb.back':       'Back',
    'onb.next':       'Next',
    'onb.start':      'Start chatting',
    'onb.done':       'Done',
    'onb.lang.title': 'Which language shall we speak?',
    'onb.name.title': 'What would you like me to call you?',
    'onb.name.label': 'What to call you',
    'onb.name.hint':  'You can change this later in About Me.',
    'onb.int.title':  'What do you enjoy?',
    'onb.int.hint':   'Tap any you like. I will remember them, so we can talk about them.',
    'onb.int.more':   'Anything else you enjoy?',
    'onb.int.gardening': 'Gardening',        'onb.int.gardening.topic': 'gardening',          'onb.int.gardening.mem': 'Enjoys gardening',
    'onb.int.cooking':   'Cooking',          'onb.int.cooking.topic':   'cooking',            'onb.int.cooking.mem':   'Enjoys cooking',
    'onb.int.music':     'Music',            'onb.int.music.topic':     'music',              'onb.int.music.mem':     'Enjoys music',
    'onb.int.mahjong':   'Mahjong & cards',  'onb.int.mahjong.topic':   'mahjong and cards',  'onb.int.mahjong.mem':   'Enjoys mahjong and cards',
    'onb.int.walking':   'Walking',          'onb.int.walking.topic':   'walking',            'onb.int.walking.mem':   'Enjoys walking',
    'onb.int.reading':   'Reading',          'onb.int.reading.topic':   'reading',            'onb.int.reading.mem':   'Enjoys reading',
    'onb.int.tv':        'TV & films',       'onb.int.tv.topic':        'television and films', 'onb.int.tv.mem':      'Enjoys television and films',
    'onb.int.faith':     'Faith & worship',  'onb.int.faith.topic':     'faith and worship',  'onb.int.faith.mem':     'Enjoys faith and worship',
    'onb.int.crafts':    'Crafts & sewing',  'onb.int.crafts.topic':    'crafts and sewing',  'onb.int.crafts.mem':    'Enjoys crafts and sewing',
    'onb.int.pets':      'Pets & animals',   'onb.int.pets.topic':      'animals',            'onb.int.pets.mem':      'Enjoys pets and animals',
    'onb.fam.title':  'Who is in your family?',
    'onb.fam.hint':   'Tap any that fit. I will remember them.',
    'onb.fam.names':  'Their names, if you like',
    'onb.fam.children':      'Children',           'onb.fam.children.mem':      'Has children',
    'onb.fam.grandchildren': 'Grandchildren',      'onb.fam.grandchildren.mem': 'Has grandchildren',
    'onb.fam.spouse':        'Husband or wife',    'onb.fam.spouse.mem':        'Has a husband or wife',
    'onb.fam.siblings':      'Brothers & sisters', 'onb.fam.siblings.mem':      'Has brothers and sisters',
    'onb.fam.friends':       'Close friends',      'onb.fam.friends.mem':       'Has close friends',
    'onb.fam.pet':           'A pet',              'onb.fam.pet.mem':           'Has a pet',
    'onb.centre.title':   'Do you go to a community centre?',
    'onb.centre.intro':   'If you do, choose it and ask to join. Its manager sees your name and decides. Once they say yes, the centre can see and change your profile, memories, life story and form details, see your chat summaries and daily check-ins, and set how your companion talks, like for any member.',
    'onb.centre.none':    'There are no community centres to choose from yet. You can ask to join one later from the chat screen.',
    'onb.centre.search':  'Search by name or town',
    'onb.centre.ask':     'Ask to join',
    'onb.centre.pick':    'Choose a centre first.',
    'onb.centre.asked':   'Asked ✓ — your request is waiting for {centre}. Their answer will show on the chat screen.',
    'onb.centre.failed':  'Your request could not be sent just now. You can try again later from the chat screen.',
    'onb.centre.member':  'You are a member of {centre}.',
    'onb.centre.pending': 'You have asked to join {centre}. Waiting for their answer.',
    'onb.centre.cancel':  'Cancel request',
    'onb.how.title': 'How Techable works',
    'onb.how.1':     'Tap to talk, or type. I listen and answer, and I can read my answers aloud.',
    'onb.how.2':     'Chats save themselves. Tap “Finish for now” when you are done.',
    'onb.how.3':     'My Story keeps the stories you tell me, like a book.',
    'onb.how.4':     'Family shows the messages, voice notes and photos your family send you.',
    'onb.saveFailed': 'Your answers could not be saved just now. You can add them later in About Me.',
    'greet.welcome':          'It is lovely to meet you. What would you like to talk about today?',
    'greet.welcome.interest': 'It is lovely to meet you. You told me you enjoy {interest} — what do you love most about it?',
    // The centre card on the chat screen.
    'centre.label':            'Your community centre',
    'centre.none':             'No community centre connected yet',
    'centre.none.details':     'Choose your centre and ask to join.',
    'centre.choose':           'Choose a centre',
    'centre.ask':              'Ask to join',
    'centre.cancel':           'Cancel request',
    'centre.cancelled':        'Request cancelled',
    'centre.confirmCancel':    'Cancel your request to join {centre}?',
    'centre.pending.details':  'Asked to join — waiting for the centre to reply.',
    'centre.declined':         '{centre} could not add you',
    'centre.declined.details': 'You can ask another centre.',
    'centre.notLinked.details': 'Not connected yet — ask to join so the centre can see you.',
    'centre.connected':        'Your account is connected to this centre.',
    'centre.upcoming':         'Upcoming: {what}',

    // ── Guesses ─────────────────────────────────────────────────
    'guess.family.ask':       'Is it because {who} might visit soon?',
    'guess.family.who':       'someone in your family',
    'guess.family.then':      'How lovely. Do you know when they are coming?',
    'guess.family.yes':       'Very soon',
    'guess.family.yes.reply': 'Something to look forward to makes the days go faster, does it not?',
    'guess.family.no':        'Not sure yet',
    'guess.family.no.reply':  'Even not knowing, it is nice to have it ahead of you. Perhaps a phone call in the meantime?',

    // Two wordings, because a hobby arrives as either an activity ("going on
    // walks near the river") or a thing ("her rose garden"), and one sentence
    // cannot hold both without reading as broken English.
    'guess.hobby.ask.activity': 'Is it because you have been {hobby}?',
    'guess.hobby.ask.thing':    'Is it because you spent some time on {hobby}?',
    'guess.hobby.ask':          'Is it because you spent some time on something you enjoy?',
    'guess.hobby.then':         'That is good to hear. Did you get much time for it today?',
    'guess.hobby.yes':          'A good while',
    'guess.hobby.yes.reply':    'That sounds like a day well spent.',
    'guess.hobby.no':           'Only a little',
    'guess.hobby.no.reply':     'Even a few quiet minutes with something you love can lift a day.',

    // English speaks OpenWeather's own line ("Light rain, around 24°C"). The
    // other packs rebuild it from the wet/pleasant flags — see weatherSummary()
    // in checkin.js — so a Cantonese sentence does not end in English.
    'weather.cond.wet':  'it is wet out',
    'weather.cond.fine': 'it is a fine day',
    'weather.cond.dull': 'it is rather grey',
    'weather.summary':   '{cond}, around {temp}°C',

    'guess.weather.ask':          'Is it because of the weather today?',
    'guess.weather.then':         'The weather does make a difference, does it not? Have you been outside yet?',
    'guess.weather.then.known':   'I had a look — {summary} where you are. Have you been outside yet?',
    'guess.weather.yes':          'Yes, I have',
    'guess.weather.yes.reply':      'Good for you. A bit of fresh air makes the whole day feel lighter.',
    'guess.weather.yes.reply.wet':  'Good for you, braving that. A bit of air makes the day feel lighter even so.',
    'guess.weather.no':           'Not yet',
    'guess.weather.no.reply':       'Maybe a short walk later, or a gentle stretch by the window — only if you feel up to it.',
    'guess.weather.no.reply.pain':  'Even sitting by an open window for a few minutes can be a nice change of scene.',
    'guess.weather.no.reply.wet':   'Probably one to stay dry indoors for. A warm drink by the window sounds better.',
    'guess.weather.no.reply.dull':  'Maybe one to enjoy from indoors today. Is there a window with a nice view where you are?',

    'guess.friends.ask':       'Is it because you had a nice chat with someone?',
    'guess.friends.then':      'Those chats are worth a lot. Was it someone you had not spoken to in a while?',
    'guess.friends.yes':       'Yes, a while',
    'guess.friends.yes.reply': 'Those catch-ups are the best kind. It is nice when someone thinks of you.',
    'guess.friends.no':        'No, we speak often',
    'guess.friends.no.reply':  'How good to have someone familiar to talk to.',

    'guess.event.ask':       'Is it because you are looking forward to {event}?',
    'guess.event.what':      'something coming up',
    'guess.event.then':      'Is it coming up soon?',
    'guess.event.yes':       'Very soon',
    'guess.event.yes.reply': 'How nice to have that just around the corner.',
    'guess.event.no':        'A little while yet',
    'guess.event.no.reply':  'Still lovely to have it on the horizon to look forward to.',

    'guess.sleep.ask':       'Is it because you did not sleep well last night?',
    'guess.sleep.then':      'That does make a day harder. Do you think you might rest a little later on?',
    'guess.sleep.yes':       'Yes, I might',
    'guess.sleep.yes.reply': 'A little rest sounds like a kind thing to do for yourself.',
    'guess.sleep.no':        'Probably not',
    'guess.sleep.no.reply':  'I hope tonight is a gentler night for you. And if you find yourself awake again, I am here — we can always talk.',

    'guess.pain.ask.site':  'Is it because your {site} is bothering you?',
    'guess.pain.ask':       'Is it because something is aching or bothering you?',
    'guess.pain.then':      'I am sorry to hear that. Have you been able to tell anyone about it?',
    'guess.pain.yes':       'Yes, I have',
    'guess.pain.yes.reply': 'I am glad someone knows, so they can keep an eye on it with you.',
    'guess.pain.no':        'Not yet',
    'guess.pain.no.reply':  'Do let someone know today — anyone close to you would want to. I will be thinking of you.',

    'guess.lonely.ask':       'Is it because it has felt quiet or lonely today?',
    'guess.lonely.then':      'Quiet days can feel long. Is there someone you would like to hear from?',
    'guess.lonely.yes':       'Yes, there is',
    'guess.lonely.yes.reply': 'I understand how that feels. Give them a ring if you can — and if there is nobody about, you can always talk with me. I am here whenever you like.',
    'guess.lonely.no':        'Not really',
    'guess.lonely.no.reply':  'Then I am glad we could have a little chat, just the two of us.',

    'guess.appetite.ask':       'Is it because you have not felt like eating?',
    'guess.appetite.then':      'Has anything tasted good to you lately?',
    'guess.appetite.yes':       'Yes, some things',
    'guess.appetite.yes.reply': 'That is good to hear. Small things you enjoy are worth holding on to.',
    'guess.appetite.no':        'Not really',
    'guess.appetite.no.reply':  'Thank you for telling me. Do mention it to someone close to you — and tell me what you used to love eating most.',

    'guess.famworry.ask':       'Is it because you are missing {who}?',
    'guess.famworry.who':       'your family',
    'guess.famworry.then':      'That is a hard thing to sit with. When did you last speak with them?',
    'guess.famworry.yes':       'Quite recently',
    'guess.famworry.yes.reply': 'It can still feel far away even so, can it not?',
    'guess.famworry.no':        'A while ago',
    'guess.famworry.no.reply':  'Perhaps this is the week to give them a ring. And in the meantime you have me — tell me what they are like.',

    // Direction-free questions, used when the day is genuinely neither good nor
    // bad. None of them assumes a cause, so none of them can get the mood
    // backwards the way "is it because you had a nice chat?" does.
    'guess.quiet.ask':       'Has it been a quiet sort of day?',
    'guess.quiet.then':      'Has it been a peaceful kind of quiet?',
    'guess.quiet.yes':       'Yes, peaceful',
    'guess.quiet.yes.reply': 'That is a good kind of day to have.',
    'guess.quiet.no':        'It has dragged',
    'guess.quiet.no.reply':  'Quiet days can drag, can they not? I am glad we are having a talk now.',

    'guess.routine.ask':       'Has today been much like most days for you?',
    'guess.routine.then':      'Do you like it when the days are much the same?',
    'guess.routine.yes':       'Yes, I do',
    'guess.routine.yes.reply': 'There is a lot to be said for a steady, familiar day.',
    'guess.routine.no':        'Not really',
    'guess.routine.no.reply':  'A bit of variety would be welcome, would it not?',

    'guess.outing.ask':       'Have you been out of the house at all today?',
    'guess.outing.then':      'Do you enjoy getting out and about?',
    'guess.outing.yes':       'Yes, I do',
    'guess.outing.yes.reply': 'Getting out does change the shape of a day.',
    'guess.outing.no':        'Not really',
    'guess.outing.no.reply':  'There is nothing wrong with a day at home either.'
  }

  // ── Mandarin (Simplified) ─────────────────────────────────────
  // Spoken register, not written. 您 throughout: the listener is elderly.
  const cmn = {
    'mood.good':  '开心',
    'mood.okay':  '还好',
    'mood.low':   '不太好',
    'mood.tired': '疲倦',

    'greet.morning':   ({ name }) => (name ? `${name}，早上好。` : '早上好。'),
    'greet.afternoon': ({ name }) => (name ? `${name}，下午好。` : '下午好。'),
    'greet.evening':   ({ name }) => (name ? `${name}，晚上好。` : '晚上好。'),
    'greet.opener':    '很高兴听到您的声音。今天想聊些什么呢？',

    'open.voice':     '{name}，您好。今天感觉怎么样？',
    'open.buttons':   '{name}，您好。让我来猜猜您今天过得怎么样。',
    'ask.mood':       '今天感觉怎么样？',
    'ask.mood.retry': '我没有太听清楚。您觉得今天算是好的一天、还过得去，还是不太好呢？',

    'ask.lean':      '「还好」可以有很多意思。您觉得今天比较偏向好的一天，还是比较难过的一天呢？',
    'lean.positive': '偏好一些',
    'lean.neutral':  '就很平常',
    'lean.negative': '比较难过',

    'answer.yes':      '对',
    'answer.close':    '有一点',
    'answer.no':       '再猜猜',
    'answer.q.yes':    '是的',
    'answer.q.close':  '说不准',
    'answer.q.no':     '不是',
    'ask.yesno.retry': '不好意思，您是说是，还是不是呢？',
    'guess.progress': '第{number}次猜测，共{total}次。',
    'guess.question.progress': '第{number}个问题，共{total}个。',

    'ask.more':          '谢谢您告诉我。想再多说一点吗？',
    'close.q':           '还想再跟我说些什么吗？',
    'close.more':        '再说一点',
    'close.done':        '就这样吧',
    'open.listening':    '我在听。您想跟我说什么呢？',
    'open.noguess':      '今天我猜不到了。您心里在想些什么呢？',
    'open.nothing':      '跟我说说，您今天心里在想些什么。',
    'open.outofguesses': '我猜完了，您赢了。可以告诉我是什么吗？',
    'wait':              '请稍等…',

    'finish.bye':    '谢谢您，{name}。明天我再来问候您。',
    'finish.prompt': '谢谢您今天来聊天。',
    'finish.btn':    '完成',

    // See the English pack: these promised a notification that is never sent.
    'esc.emergency': '谢谢您告诉我。这件事很重要，我希望有人来帮您。我已经把这件事记下来，让您的照护团队看到。如果您现在就需要帮助，请拨打紧急电话，或者叫身边的人帮忙。',
    'esc.urgent':    '谢谢您告诉我。我已经把这件事记下来，让照护团队的人看到，好好地帮助您。如果这件事不能等，请告诉身边的人，或者您自己联系他们。',
    'esc.prompt':    '正在为您找人帮忙',
    'esc.title':     '⚠️ 已为您记录，交照护团队查看',
    'esc.body':      '这次问候已经停止，并已保存下来让您的照护团队查看。如果这件事不能等，请您自己联系他们。',
    'esc.body.emergency': '这次问候已经停止，并已保存下来让您的照护团队查看。如果情况紧急，请立刻拨打当地的紧急电话，不要等人来看这条记录。',
    'esc.close':     '关闭',

    'fallback.discomfort': '谢谢您告诉我，{name}。听起来很不舒服，记得跟身边亲近的人说一声。有什么方法能让您好过一些吗？',
    'fallback.loneliness': '谢谢您跟我说这些，{name}。安静的日子会显得特别长——那时候您随时都可以跟我聊聊。您想聊些什么呢？',
    'fallback.good':       '听到这个真好，{name}。今天最开心的是哪一件事呢？',
    'fallback.default':    '谢谢您告诉我，{name}。很高兴您愿意跟我说。有什么会让明天好过一点呢？',

    'card.title':  '☀️ 今天的问候',
    'card.sub':    '每天几分钟，聊聊您的心情',
    'card.invite': 'Techable 想听听您今天过得怎么样。',
    'card.start':  '💬 开始今天的聊天',
    'card.note':   '会在聊天里进行，一两分钟就好。随时可以停下来。',
    'ui.repeat':   '再说一次',
    'ui.stop':     '停止',
    'ui.send':     '发送',
    'ui.ready':    '准备中…',
    'ui.placeholder': '可以在这里打字，或点一下麦克风直接说话…',
    'ui.answer':   '您的回答',
    'ui.mic.start': '说出您的回答',
    'ui.mic.stop':  '说完了，送出回答',

    'toast.selectFirst':    '请先选择一位长者的档案',
    'toast.saved':          '问候已保存 ✓',
    'toast.stopped':        '问候已停止',
    'toast.stoppedPartial': '问候已停止——已保存部分回答',
    'toast.noSpeech':       '这个浏览器不支持语音辨识',
    'toast.micBlocked':     '麦克风被封锁了。请在浏览器设置里允许使用，然后再点一次麦克风。',
    'toast.micStartFailed': '无法启动麦克风。请再点一次麦克风重试。',
    'toast.speechNetwork':  '语音输入无法连接到语音服务。请重试，或在下方输入您的回答。',

    // ── 聊天画面（F48）
    'nav.chat':     '聊天',
    'nav.memories': '回忆',
    'nav.history':  '以前的聊天',
    'nav.about':    '关于我',
    'hub.title':    '关于我',
    'hub.memories': '我记得的关于您的事',
    'hub.history':  '以前的聊天',
    'hub.forms':    '表格和福利',
    'hub.centres':  '中心和消息',
    'hub.help':     '帮助和常见问题',
    'hub.logout':   '退出登录',
    'hub.back':     '返回「关于我」',
    'talk.idle':           '点一下说话',
    'talk.ready':          '准备中…',
    'talk.listening':      '正在听…说完点一下',
    'talk.ready.aria':     '正在准备收听',
    'talk.listening.aria': '正在听——点一下停止并发送',
    'chat.placeholder':    '或者在这里打字…',
    'aloud.label':     '朗读回复：',
    'aloud.on':        '开',
    'aloud.off':       '关',
    'aloud.toast.on':  '回复会读出来 🔊',
    'aloud.toast.off': '回复不会读出来 🔇',
    'chat.finish':  '先聊到这里',
    'chat.bye':     '谢谢您跟我聊天，{name}。想再聊的时候，我随时都在。',
    'chat.ended':   '这次聊天结束了。',
    'chat.again':   '💬 开始新的聊天',

    // ── 对话（F46）
    'greet.offer':     '很高兴听到您的声音。想玩今天的心情小游戏吗？还是我们就聊聊天？',
    'ask.mood.game':   '好呀！您今天感觉怎么样？',
    'offer.declined':  '当然可以。我们就随便聊聊——想说什么都可以。',
    'ack.mood.good':   '听到这个真好。',
    'ack.mood.okay':   '谢谢您告诉我。',
    'ack.mood.low':    '很抱歉您今天感觉不太好。',
    'ack.mood.tired':  '哎呀，今天很累啊。',
    'ack.lean.positive': '那就是偏好的一天。',
    'ack.lean.neutral':  '那就是平平常常的一天。',
    'ack.lean.negative': '很抱歉今天过得比较辛苦。',
    'ack.miss':        '不是这个呀。',
    'ack.close':       '有一点点呀。',
    'ack.declined':    '没关系，不想说也可以。谢谢您告诉我您的心情。',
    'ack.ok':          '没关系。',
    'reply.low.who':     '听到您{who}的事，我很难过。听起来不容易。发生了什么事？',
    'reply.low.1':       '很抱歉您今天过得不太好。想跟我说说吗？',
    'reply.low.2':       '听起来这段时间不容易，我很难过。现在最让您放不下的是什么？',
    'reply.low.3':       '谢谢您跟我说真心话。我在这里陪着您。有什么能让您好过一点吗？',
    'reply.tired.1':     '累的时候就好好休息。今天有机会休息一下吗？',
    'reply.tired.2':     '一累，什么都提不起劲。有没有什么轻松的事能让您歇一歇？',
    'reply.pain':        '很难过您不舒服。记得跟身边亲近的人说一声。平时这样的时候，什么能让您舒服一点？',
    'reply.lonely.1':    '听起来有点孤单。您想聊的时候，我随时都在。最近在想念谁呢？',
    'reply.lonely.2':    '我明白那种感觉。身边没人的时候，您随时都可以跟我聊。您想聊些什么？',
    'reply.good.who':    '听到您{who}的事真好！你们一起做了什么？',
    'reply.good.1':      '听到这个真好。是什么让它这么好呢？',
    'reply.good.2':      '真替您高兴。发生了什么事呢？',
    'reply.who':         '跟我说说您的{who}吧。他们是个怎样的人？',
    'reply.remember':    '我很想多听一点。您记得最清楚的是什么？',
    'reply.no.topic':    '没关系。要不要跟我聊聊「{topic}」？',
    'reply.no.plain':    '没关系，想聊什么都可以，或者就休息一下。',
    'reply.offerStop':   '完全没关系，现在不一定要聊。今天就先聊到这里，好吗？',
    'reply.memory':      '这让我想起您跟我说过的：「{mem}」。可以再多讲一点吗？',
    'reply.open.1':      '最近心里在想些什么呢？',
    'reply.open.2':      '这个星期有没有什么让您期待的事？',
    'reply.open.3':      '最近有什么让您笑了的事吗？',
    'reply.open.4':      '如果现在可以吃任何东西，您最想吃什么？',
    'reply.open.day':    '您今天过得怎么样？',
    'reply.rest':        '跟您聊天真开心。想再聊的时候，我随时都在。',
    'ai.offline':        '我现在有点难以思考，所以回答可能会简单一些。',
    'ai.offline.short':  '暂时是简单回复',

    'starters.title':    '想聊点什么吗？',
    'starter.game':      '今天的心情小游戏',
    'starter.memory':    '您跟我说过：「{mem}」。能再跟我多说一点吗？',
    'starter.open.smile': '让您笑的事',
    'starter.open.meal':  '最喜欢吃的菜',
    'starter.open.ahead': '这星期的打算',
    'starter.open.young': '年轻的时候',
    'starter.open.place': '您喜爱的地方',
    'starter.ask.young':  '您年轻的时候，有什么开心的回忆？',
    'starter.ask.place':  '有没有一个您一直都很喜欢的地方？',

    'story.ch.childhood': '童年',
    'story.ch.school':    '求学时光',
    'story.ch.work':      '工作',
    'story.ch.love':      '爱情与婚姻',
    'story.ch.family':    '家庭',
    'story.ch.recipes':   '拿手菜',
    'story.ch.places':    '去过的地方',
    'story.ch.lessons':   '人生道理',
    'story.ch.other':     '其他故事',
    'story.topic.childhood': '您的童年',
    'story.topic.school':    '您上学的时候',
    'story.topic.work':      '您工作的日子',
    'story.topic.love':      '爱情与婚姻',
    'story.topic.family':    '您的家人',
    'story.topic.recipes':   '您的拿手菜',
    'story.topic.places':    '您去过的地方',
    'story.topic.lessons':   '人生教会您的事',
    'story.topic.other':     '您的一个故事',
    'story.ask.childhood': '我很想听听您小时候的事。您最早的回忆是什么？',
    'story.ask.school':    '跟我说说您上学的时候吧。您的学校是什么样的？',
    'story.ask.work':      '跟我说说您做过的工作吧。您的第一份工作是什么？',
    'story.ask.love':      '跟我说说您爱过的人吧。你们是怎么认识的？',
    'story.ask.family':    '跟我说说您的家人吧。有什么珍贵的家庭回忆？',
    'story.ask.recipes':   '跟我说说您的拿手菜吧。是怎么做的？',
    'story.ask.places':    '跟我说说一个对您很重要的地方吧。您记得那里的什么？',
    'story.ask.lessons':   '生活教会了您什么，是您希望别人也知道的？',
    'story.ask.other':     '有没有一个您想跟我讲的人生故事？',
    'story.more.1':  '关于这个，您还记得些什么？',
    'story.more.2':  '那时候还有谁跟您在一起？',
    'story.more.3':  '那时候您是什么感觉？',
    'story.go':      '请继续说，我在听。',
    'story.saved':   '谢谢您跟我说这些。我已经把它记在您的人生故事里了，在「{chapter}」那一章。',
    'story.notnow':  '没关系。我们可以聊点别的，什么都可以。',
    'story.thanks':  '谢谢您跟我说这些，听着真好。',
    'story.toast.full':    '您的人生故事已经满了。请在「我的故事」里删除一个，再加新的。',
    'story.suggested':     '这听起来像是您人生故事里的一段。它在「我的故事」里等着，您想留的话可以留下。',
    'story.waiting.title': '聊天里的故事',
    'story.waiting.intro': '这些只存在这台设备上，等您决定。只有您留下的才会放进书里，您的中心、连接的家人和护理人员都可以看到。',
    'story.keep':          '放进「{chapter}」',
    'story.dismiss':       '不要这个',
    'story.private':       '谢谢您信任我，跟我说这些。我没有把它放进您的人生故事书里。',
    'story.toast.saved':   '已记在您的人生故事里 ✓',
    'story.toast.updated': '故事已更新 ✓',
    'story.toast.removed': '故事已删除',
    'story.toast.failed':  '您的故事暂时保存不了，请稍后再试。',
    'nav.story':      '我的故事',
    'story.title':    '我的人生故事',
    'story.intro':    '您跟我讲的故事，像一本书一样按章节收好。每一个都可以修改或删除。您的中心、您连接的家人和为您服务的护理人员也可以看到。',
    'story.print':    '打印或存成 PDF',
    'story.tell':     '说给我听',
    'story.write':    '我自己写',
    'story.empty':    '还没有故事。',
    'story.edit':     '修改',
    'story.remove':   '删除',
    'story.save':     '保存',
    'story.cancel':   '取消',
    'story.yours':    '您的故事',
    'story.chapter':  '章节',
    'story.confirmRemove': '要从书里删除这个故事吗？',
    'story.src.story':        '讲给 Techable 听的',
    'story.src.conversation': '来自聊天',
    'story.src.manual':       '您自己写的',
    'story.book':     ({ name }) => (name ? `${name}的人生故事` : '我的人生故事'),

    'nav.family':        '家人',
    'inbox.navLabel':    '家人，{n}条新留言',
    'inbox.title':       '家人给您的留言',
    'inbox.intro':       '家人通过 Techable 给您的留言、语音和照片。每一条在这里只有您和发送的人可以打开。在聊天里打开后，它就成了那次聊天的一部分。',
    'inbox.ask':          '{name}想给您发留言。',
    'inbox.ask.relation': '对方说是您的{relation}。',
    'inbox.ask.q':        '您认识这个人吗？',
    'inbox.allow':        '认识，显示留言',
    'inbox.block':        '不认识，拦截',
    'inbox.allowed':      '{name}的留言现在会显示在这里。',
    'inbox.blocked':      '{name}不能再给您发留言了。',
    'inbox.confirmBlock': '要拦截{name}吗？对方的留言会被删除，以后也不能再给您发。',
    'inbox.saveFailed':   '暂时保存不了，请稍后再试。',
    'inbox.tapToPlay':    '点 ▶ 播放语音留言。',
    'link.ask':           '{name}想和您的账户连接。',
    'link.ask.what':      '您同意的话，对方可以看到您的资料、聊天摘要、每日问候和人生故事，也可以给您发留言。',
    'link.allow':         '认识，连接',
    'link.allowed':       '{name}现在和您连接了。',
    'link.blocked':       '{name}不能和您连接，也不能给您发留言。',
    'link.confirmBlock':  '要拦截{name}吗？对方将不能和您连接，也不能给您发留言。',
    'link.title':         '和您连接的人',
    'link.intro':         '这些家人账户可以看到您的资料、聊天摘要、每日问候和人生故事。',
    'link.remove':        '移除',
    'link.confirmRemove': '要移除{name}吗？对方将不能再看到您的资料、聊天、每日问候和人生故事。',
    'link.removed':       '{name}已经不再和您连接。',
    'link.loadFailed':    '暂时查不到谁和您连接了。',
    'find.title':         '让家人找到我',
    'find.intro':         '开启后，您的家人可以在 Techable 输入您的电子邮箱找到您，并请求连接。每个请求都由您决定。',
    'find.saved.on':      '现在您的家人可以找到您了。',
    'find.saved.off':     '现在没有人能用您的电子邮箱找到您。',
    'onb.find':           '让家人找到我',
    'onb.find.hint':      '这样您的家人可以用您的电子邮箱找到您，并请求连接。每个请求都由您决定。',
    'inbox.empty':       '还没有留言。家人通过 Techable 给您留言、发语音或照片时，会出现在这里。',
    'inbox.loading':     '正在加载…',
    'inbox.loadFailed':  '家人的留言暂时加载不了。',
    'inbox.mediaFailed': '这段录音或照片暂时加载不了。',
    'inbox.new':         '新',
    'inbox.play':        '▶ 播放',
    'inbox.show':        '🖼 看照片',
    'inbox.read':        '🔊 读给我听',
    'inbox.delete':      '删除',
    'inbox.confirmDelete': '要删除这条留言吗？删除后您和发送的人都看不到了。',
    'inbox.deleted':     '留言已删除',
    'inbox.deleteFailed': '这条留言暂时删除不了。',
    'inbox.who.rel':     '您的{relation}{person}',
    'inbox.who.relOnly': '您的{relation}',
    'inbox.who.someone': '家里人',
    'inbox.text.left':   '{who}{when}给您留了言。想听听吗？',
    'inbox.voice.left':  '{who}{when}给您留了一段语音。想听听吗？',
    'inbox.photo.left':  '{who}{when}给您发了一张照片。想看看吗？',
    'inbox.many':        '您有{n}条家人的新留言。想听听吗？',
    'inbox.another':     '还有一条留言，是{who}的。想听吗？',
    'inbox.later':       '好的。它会一直在「家人」里等您。',
    'inbox.says':        '{who}说：「{text}」',
    'inbox.voice.here':  '这是{who}的语音留言。',
    'inbox.photo.here':  '这是{who}发来的照片。',
    'inbox.caption':     '留言写着：「{text}」',
    'inbox.caption.by':  '{person}写道：「{text}」',
    'inbox.photoAlt':    '{who}发来的照片',
    'starter.family':      '{person}的留言',
    'starter.family.many': '{n}条家人留言',
    'when.morning':   '今天上午',
    'when.afternoon': '今天下午',
    'when.evening':   '今天晚上',
    'when.yesterday': '昨天',
    'when.day':       '{day}',
    'when.recent':    '最近',
    'rel.daughter': '女儿', 'rel.son': '儿子', 'rel.granddaughter': '孙女', 'rel.grandson': '孙子',
    'rel.grandchild': '孙儿', 'rel.wife': '太太', 'rel.husband': '先生', 'rel.partner': '伴侣',
    'rel.sister': '姐妹', 'rel.brother': '兄弟', 'rel.niece': '侄女', 'rel.nephew': '侄子',
    'rel.cousin': '表亲', 'rel.friend': '朋友', 'rel.neighbour': '邻居', 'rel.carer': '照顾您的人',

    'onb.welcome':    '欢迎来到 Techable。我是您的陪伴者，想多认识您一点。大约一分钟，每一步都可以跳过。',
    'onb.step':       '第{n}步，共{total}步',
    'onb.skipAll':    '先跳过',
    'onb.back':       '上一步',
    'onb.next':       '下一步',
    'onb.start':      '开始聊天',
    'onb.done':       '完成',
    'onb.lang.title': '我们说哪种语言？',
    'onb.name.title': '我该怎么称呼您？',
    'onb.name.label': '称呼',
    'onb.name.hint':  '以后可以在「关于我」里修改。',
    'onb.int.title':  '您喜欢做什么？',
    'onb.int.hint':   '喜欢的都可以点。我会记住，以后可以聊。',
    'onb.int.more':   '还喜欢什么吗？',
    'onb.int.gardening': '园艺',       'onb.int.gardening.topic': '园艺',       'onb.int.gardening.mem': '喜欢园艺',
    'onb.int.cooking':   '做饭',       'onb.int.cooking.topic':   '做饭',       'onb.int.cooking.mem':   '喜欢做饭',
    'onb.int.music':     '音乐',       'onb.int.music.topic':     '音乐',       'onb.int.music.mem':     '喜欢音乐',
    'onb.int.mahjong':   '麻将和打牌', 'onb.int.mahjong.topic':   '打麻将和打牌', 'onb.int.mahjong.mem': '喜欢打麻将和打牌',
    'onb.int.walking':   '散步',       'onb.int.walking.topic':   '散步',       'onb.int.walking.mem':   '喜欢散步',
    'onb.int.reading':   '看书',       'onb.int.reading.topic':   '看书',       'onb.int.reading.mem':   '喜欢看书',
    'onb.int.tv':        '电视和电影', 'onb.int.tv.topic':        '看电视和电影', 'onb.int.tv.mem':      '喜欢看电视和电影',
    'onb.int.faith':     '信仰和礼拜', 'onb.int.faith.topic':     '信仰',       'onb.int.faith.mem':     '有宗教信仰',
    'onb.int.crafts':    '手工和缝纫', 'onb.int.crafts.topic':    '手工和缝纫', 'onb.int.crafts.mem':    '喜欢做手工和缝纫',
    'onb.int.pets':      '宠物和动物', 'onb.int.pets.topic':      '动物',       'onb.int.pets.mem':      '喜欢宠物和动物',
    'onb.fam.title':  '您家里有哪些人？',
    'onb.fam.hint':   '符合的都可以点。我会记住。',
    'onb.fam.names':  '他们的名字（可以不填）',
    'onb.fam.children':      '子女',     'onb.fam.children.mem':      '有子女',
    'onb.fam.grandchildren': '孙子孙女', 'onb.fam.grandchildren.mem': '有孙子孙女',
    'onb.fam.spouse':        '老伴',     'onb.fam.spouse.mem':        '有老伴',
    'onb.fam.siblings':      '兄弟姐妹', 'onb.fam.siblings.mem':      '有兄弟姐妹',
    'onb.fam.friends':       '好朋友',   'onb.fam.friends.mem':       '有好朋友',
    'onb.fam.pet':           '宠物',     'onb.fam.pet.mem':           '养了宠物',
    'onb.centre.title':   '您有去社区中心吗？',
    'onb.centre.intro':   '如果有，选好中心再申请加入。中心的负责人会看到您的名字并决定。同意以后，中心可以像对其他成员一样，查看和修改您的资料、回忆、人生故事和表格内容，看到您的聊天摘要和每日问候，并设定陪伴者怎么说话。',
    'onb.centre.none':    '目前还没有可以选择的社区中心。以后可以在聊天页面申请加入。',
    'onb.centre.search':  '按名称或地区搜索',
    'onb.centre.ask':     '申请加入',
    'onb.centre.pick':    '请先选一个中心。',
    'onb.centre.asked':   '已申请 ✓ ——您的申请正在等{centre}处理。他们的回复会显示在聊天页面。',
    'onb.centre.failed':  '申请暂时发不出去，请稍后在聊天页面再试。',
    'onb.centre.member':  '您是{centre}的成员。',
    'onb.centre.pending': '您已申请加入{centre}，正在等他们回复。',
    'onb.centre.cancel':  '取消申请',
    'onb.how.title': 'Techable 怎么用',
    'onb.how.1':     '点「说话」或者打字。我会听、会回答，也可以把回答读出来。',
    'onb.how.2':     '聊天会自动保存。聊完了点「先聊到这里」。',
    'onb.how.3':     '「我的故事」会像一本书一样收好您讲的故事。',
    'onb.how.4':     '「家人」里有家人发给您的留言、语音和照片。',
    'onb.saveFailed': '您的回答暂时保存不了。以后可以在「关于我」里补上。',
    'greet.welcome':          '很高兴认识您。今天想聊些什么呢？',
    'greet.welcome.interest': '很高兴认识您。您说您喜欢{interest}——最喜欢的是什么呢？',
    'centre.label':            '您的社区中心',
    'centre.none':             '还没有连接社区中心',
    'centre.none.details':     '选择您的中心并申请加入。',
    'centre.choose':           '选择中心',
    'centre.ask':              '申请加入',
    'centre.cancel':           '取消申请',
    'centre.cancelled':        '申请已取消',
    'centre.confirmCancel':    '要取消加入{centre}的申请吗？',
    'centre.pending.details':  '已申请加入，正在等中心回复。',
    'centre.declined':         '{centre}暂时不能加您',
    'centre.declined.details': '您可以申请别的中心。',
    'centre.notLinked.details': '还没有连接——申请加入后，中心才能看到您。',
    'centre.connected':        '您的账户已连接到这个中心。',
    'centre.upcoming':         '即将举行：{what}',

    'guess.family.ask':       '是因为{who}快要来看您了吗？',
    'guess.family.who':       '家里人',
    'guess.family.then':      '那真好。您知道他们什么时候来吗？',
    'guess.family.yes':       '很快就来',
    'guess.family.yes.reply': '有件事情可以盼着，日子也过得快些，是不是？',
    'guess.family.no':        '还不确定',
    'guess.family.no.reply':  '就算还没定下来，有这件事在前头也挺好的。这几天先通个电话，好不好？',

    'guess.hobby.ask.activity': '是因为您今天有时间{hobby}吗？',
    'guess.hobby.ask.thing':    '是因为您今天花了些时间在{hobby}上吗？',
    'guess.hobby.ask':          '是因为您今天做了些自己喜欢的事吗？',
    'guess.hobby.then':         '那真好。今天在这上面花了不少时间吗？',
    'guess.hobby.yes':          '有好一阵子',
    'guess.hobby.yes.reply':    '听起来这一天过得很充实。',
    'guess.hobby.no':           '只有一点点',
    'guess.hobby.no.reply':     '就算只有几分钟做喜欢的事，也能让一天好过一些。',

    'weather.cond.wet':  '正在下雨',
    'weather.cond.fine': '天气不错',
    'weather.cond.dull': '天气一般',
    'weather.summary':   '{cond}，大约{temp}度',

    'guess.weather.ask':        '是因为今天的天气吗？',
    'guess.weather.then':       '天气确实会影响心情，是不是？今天出去过了吗？',
    'guess.weather.then.known': '我看了一下，您那边{summary}。今天出去过了吗？',
    'guess.weather.yes':        '出去过了',
    'guess.weather.yes.reply':      '真好。出去透透气，整天都会轻松一些。',
    'guess.weather.yes.reply.wet':  '这种天气还愿意出门，真好。透透气，心情也会松快一点。',
    'guess.weather.no':         '还没有',
    'guess.weather.no.reply':       '晚一点也许可以走一小段，或在窗边轻轻活动一下——身体舒服再说。',
    'guess.weather.no.reply.pain':  '就算只是坐在开着的窗边几分钟，换换景色也很好。',
    'guess.weather.no.reply.wet':   '这种天气还是待在屋里干爽一些。在窗边喝杯热的，听起来更好。',
    'guess.weather.no.reply.dull':  '今天在屋里看看就好。您那边有没有一扇景色不错的窗？',

    'guess.friends.ask':       '是因为您今天跟人聊得很开心吗？',
    'guess.friends.then':      '这样的聊天很难得。是很久没联络的人吗？',
    'guess.friends.yes':       '是很久没见了',
    'guess.friends.yes.reply': '久别重逢的那种聊天最难得。有人惦记着您，真好。',
    'guess.friends.no':        '不是，我们常聊',
    'guess.friends.no.reply':  '有个熟悉的人可以说说话，真好。',

    'guess.event.ask':       '是因为您在期待{event}吗？',
    'guess.event.what':      '快要到的一件事',
    'guess.event.then':      '很快就到了吗？',
    'guess.event.yes':       '很快了',
    'guess.event.yes.reply': '就在眼前了，真让人高兴。',
    'guess.event.no':        '还要等一阵',
    'guess.event.no.reply':  '有件事情可以盼着，也是件好事。',

    'guess.sleep.ask':       '是因为昨晚没睡好吗？',
    'guess.sleep.then':      '那一整天都会比较辛苦。等一下会不会想休息一会儿？',
    'guess.sleep.yes':       '可能会',
    'guess.sleep.yes.reply': '休息一下，是对自己好一点的做法。',
    'guess.sleep.no':        '大概不会',
    'guess.sleep.no.reply':  '希望今晚您能睡得安稳些。要是又醒着，我都在——随时可以聊聊。',

    'guess.pain.ask.site':  '是因为您的{site}不舒服吗？',
    'guess.pain.ask':       '是因为身上哪里不舒服吗？',
    'guess.pain.then':      '听到这个我很心疼。这件事跟人说过了吗？',
    'guess.pain.yes':       '说过了',
    'guess.pain.yes.reply': '有人知道就好，可以一起留意着。',
    'guess.pain.no':        '还没有',
    'guess.pain.no.reply':  '今天就跟人说一声吧——亲近的人一定想知道。我会一直挂心着您。',

    'guess.lonely.ask':       '是因为今天太安静、有点孤单吗？',
    'guess.lonely.then':      '安静的日子会显得特别长。有没有谁是您想听到消息的？',
    'guess.lonely.yes':       '有的',
    'guess.lonely.yes.reply': '我明白那种感觉。方便的话就给他们打个电话——要是身边没人，您也随时可以跟我说话，我一直都在。',
    'guess.lonely.no':        '也没有',
    'guess.lonely.no.reply':  '那我很高兴我们两个能聊上几句。',

    'guess.appetite.ask':       '是因为不太想吃东西吗？',
    'guess.appetite.then':      '最近有没有什么吃着还合口味的？',
    'guess.appetite.yes':       '有一些',
    'guess.appetite.yes.reply': '那就好。喜欢的小东西，值得好好留着。',
    'guess.appetite.no':        '没有',
    'guess.appetite.no.reply':  '谢谢您告诉我。记得跟亲近的人说一声——也跟我说说，您以前最爱吃什么？',

    'guess.famworry.ask':       '是因为您在想念{who}吗？',
    'guess.famworry.who':       '家里人',
    'guess.famworry.then':      '这种心情不好受。上一次跟他们说话是什么时候呢？',
    'guess.famworry.yes':       '不久之前',
    'guess.famworry.yes.reply': '就算这样，还是会觉得他们离得很远，是不是？',
    'guess.famworry.no':        '有一阵子了',
    'guess.famworry.no.reply':  '也许这个星期给他们打个电话。在那之前还有我——跟我说说他们是什么样的人吧。',

    'guess.quiet.ask':       '今天是不是过得挺安静的？',
    'guess.quiet.then':      '这种安静，是让人舒服的那一种吗？',
    'guess.quiet.yes':       '挺舒服的',
    'guess.quiet.yes.reply': '这样的日子也很好。',
    'guess.quiet.no':        '有点难熬',
    'guess.quiet.no.reply':  '安静的日子确实会显得长，是不是？还好我们现在能聊聊。',

    'guess.routine.ask':       '今天跟平常的日子差不多吗？',
    'guess.routine.then':      '日子过得差不多，您还习惯吗？',
    'guess.routine.yes':       '还习惯',
    'guess.routine.yes.reply': '安稳、熟悉的日子，其实很难得。',
    'guess.routine.no':        '不太习惯',
    'guess.routine.no.reply':  '有点变化会好一些，是不是？',

    'guess.outing.ask':       '今天有出过门吗？',
    'guess.outing.then':      '您喜欢出去走走吗？',
    'guess.outing.yes':       '喜欢',
    'guess.outing.yes.reply': '出去走走，一整天的感觉都不一样。',
    'guess.outing.no':        '不太喜欢',
    'guess.outing.no.reply':  '在家待着也很好，没什么不好的。'
  }

  // ── Cantonese (Traditional, spoken register) ──────────────────
  const yue = {
    'mood.good':  '開心',
    'mood.okay':  '麻麻地',
    'mood.low':   '唔係太好',
    'mood.tired': '好攰',

    // 晚安 is deliberately not used for the evening: in Cantonese it means
    // "goodnight", so greeting someone with it opens the conversation by
    // ending it.
    'greet.morning':   ({ name }) => (name ? `${name}，早晨呀。` : '早晨呀。'),
    'greet.afternoon': ({ name }) => (name ? `${name}，午安呀。` : '午安呀。'),
    'greet.evening':   ({ name }) => (name ? `${name}，你好呀。` : '你好呀。'),
    'greet.opener':    '好開心聽到你把聲。今日想傾啲咩呀？',

    'open.voice':     '{name}，你好呀。今日覺得點呀？',
    'open.buttons':   '{name}，你好呀。等我估下你今日過得點。',
    'ask.mood':       '今日覺得點呀？',
    'ask.mood.retry': '我聽得唔係好清楚。你覺得今日算係好嘅一日、麻麻地，定係唔係太好呢？',

    'ask.lean':      '「麻麻地」可以有好多意思。你覺得今日係偏向好嘅一日，定係辛苦啲嘅一日呢？',
    'lean.positive': '偏好啲',
    'lean.neutral':  '好平常啫',
    'lean.negative': '辛苦啲',

    'answer.yes':      '係呀',
    'answer.close':    '有少少',
    'answer.no':       '再猜過',
    'answer.q.yes':    '係呀',
    'answer.q.close':  '講唔埋',
    'answer.q.no':     '唔係',
    'ask.yesno.retry': '唔好意思，你係話係，定係唔係呢？',
    'guess.progress': '第{number}次估，共{total}次。',
    'guess.question.progress': '第{number}個問題，共{total}個。',

    'ask.more':          '多謝你話我知。想再講多少少嗎？',
    'close.q':           '仲有冇嘢想同我講呀？',
    'close.more':        '再講多少少',
    'close.done':        '就咁多啦',
    'open.listening':    '我聽緊。你想同我講咩呢？',
    'open.noguess':      '今日我猜唔到喇。你心入面諗緊啲咩呢？',
    'open.nothing':      '同我講下，你今日心入面諗緊咩。',
    'open.outofguesses': '我猜晒喇，你贏咗。可唔可以話我知係咩事呢？',
    'wait':              '等陣先…',

    'finish.bye':    '多謝你，{name}。聽日我再嚟問候你。',
    'finish.prompt': '多謝你今日同我傾偈。',
    'finish.btn':    '完成',

    // See the English pack: these promised a notification that is never sent.
    'esc.emergency': '多謝你話我知。呢件事好重要，我想有人嚟幫你。我已經幫你記低咗，等你嘅照顧團隊睇到。如果你而家就需要幫手，請即刻打緊急電話，或者叫身邊嘅人幫你。',
    'esc.urgent':    '多謝你話我知。我已經幫你記低咗，等照顧團隊嘅人睇到，可以好好噉幫你。如果件事等唔到，請話畀身邊嘅人知，或者你自己搵佢哋。',
    'esc.prompt':    '幫緊你搵人',
    'esc.title':     '⚠️ 已經幫你記低，畀照顧團隊睇',
    'esc.body':      '呢次問候已經停咗，亦已經儲起咗畀你嘅照顧團隊睇。如果件事等唔到，請你自己搵佢哋。',
    'esc.body.emergency': '呢次問候已經停咗，亦已經儲起咗畀你嘅照顧團隊睇。如果情況緊急，請即刻打當地嘅緊急電話，唔好等人睇呢個記錄。',
    'esc.close':     '關閉',

    'fallback.discomfort': '多謝你話我知，{name}。聽落好唔舒服，記得同身邊親近嘅人講一聲。有冇啲咩可以令你舒服返啲呢？',
    'fallback.loneliness': '多謝你同我講，{name}。靜靜哋嘅日子特別長——嗰陣你隨時都可以搵我傾偈。你想傾啲咩呢？',
    'fallback.good':       '聽到就好喇，{name}。今日最開心係邊一樣呢？',
    'fallback.default':    '多謝你話我知，{name}。多謝你肯同我講。有啲咩會令聽日好過啲呢？',

    'card.title':  '☀️ 今日嘅問候',
    'card.sub':    '每日傾一陣，講下你嘅心情',
    'card.invite': 'Techable 想聽下你今日過得點。',
    'card.start':  '💬 開始今日嘅傾偈',
    'card.note':   '喺傾偈度進行，一兩分鐘就得。隨時可以停。',
    'ui.repeat':   '再講一次',
    'ui.stop':     '停',
    'ui.send':     '傳送',
    'ui.ready':    '準備緊…',
    'ui.placeholder': '可以喺呢度打字，或者撳一下咪直接講…',
    'ui.answer':   '你嘅答案',
    'ui.mic.start': '講出你嘅答案',
    'ui.mic.stop':  '講完喇，傳送答案',

    'toast.selectFirst':    '請先揀一位長者嘅檔案',
    'toast.saved':          '問候已經儲存 ✓',
    'toast.stopped':        '問候已經停咗',
    'toast.stoppedPartial': '問候已經停咗——儲低咗部分答案',
    'toast.noSpeech':       '呢個瀏覽器唔支援語音辨識',
    'toast.micBlocked':     '咪被封鎖咗。請喺瀏覽器設定度允許使用，然後再撳多次咪。',
    'toast.micStartFailed': '啟動唔到咪。請再撳一次咪試多次。',
    'toast.speechNetwork':  '語音輸入連唔到語音服務。請再試，或者喺下面打字回答。',

    // ── 傾偈畫面（F48）
    'nav.chat':     '傾偈',
    'nav.memories': '回憶',
    'nav.history':  '以前嘅傾偈',
    'nav.about':    '關於我',
    'hub.title':    '關於我',
    'hub.memories': '我記得你嘅嘢',
    'hub.history':  '以前嘅傾偈',
    'hub.forms':    '表格同福利',
    'hub.centres':  '中心同消息',
    'hub.help':     '幫助同常見問題',
    'hub.logout':   '登出',
    'hub.back':     '返去「關於我」',
    'talk.idle':           '撳一下講嘢',
    'talk.ready':          '準備緊…',
    'talk.listening':      '聽緊…講完撳一下',
    'talk.ready.aria':     '準備緊聽你講',
    'talk.listening.aria': '聽緊——撳一下停同傳送',
    'chat.placeholder':    '或者喺度打字…',
    'aloud.label':     '讀出回覆：',
    'aloud.on':        '開',
    'aloud.off':       '關',
    'aloud.toast.on':  '回覆會讀出嚟 🔊',
    'aloud.toast.off': '回覆唔會讀出嚟 🔇',
    'chat.finish':  '今次傾到呢度',
    'chat.bye':     '多謝你同我傾偈，{name}。想再傾嘅時候，我隨時都喺度。',
    'chat.ended':   '今次傾偈完咗。',
    'chat.again':   '💬 開始新嘅傾偈',

    // ── 對話（F46）
    'greet.offer':     '好開心聽到你把聲。想唔想玩今日嘅心情小遊戲？定係我哋就傾下偈？',
    'ask.mood.game':   '好呀！你今日覺得點呀？',
    'offer.declined':  '梗係得。我哋就隨便傾下——想講咩都得。',
    'ack.mood.good':   '聽到就開心。',
    'ack.mood.okay':   '多謝你話我知。',
    'ack.mood.low':    '好抱歉你今日覺得唔係幾好。',
    'ack.mood.tired':  '哎呀，今日好攰喎。',
    'ack.lean.positive': '咁即係偏好嘅一日。',
    'ack.lean.neutral':  '咁即係平平常常嘅一日。',
    'ack.lean.negative': '好抱歉今日過得辛苦啲。',
    'ack.miss':        '唔係呢樣呀。',
    'ack.close':       '有少少呀。',
    'ack.declined':    '唔緊要，唔想講都得。多謝你話我知你嘅心情。',
    'ack.ok':          '唔緊要。',
    'reply.low.who':     '聽到你{who}嘅事，我好難過。聽落唔容易。發生咗咩事呀？',
    'reply.low.1':       '好抱歉你今日過得唔係幾好。想同我講下嗎？',
    'reply.low.2':       '聽落呢排唔容易，我好難過。而家最放唔低嘅係咩呀？',
    'reply.low.3':       '多謝你同我講真心話。我喺度陪住你。有冇啲咩可以令你好過啲？',
    'reply.tired.1':     '攰就要好好休息。今日有冇機會唞下呀？',
    'reply.tired.2':     '一攰就乜都提唔起勁。有冇啲輕鬆嘅嘢可以俾你唞一唞？',
    'reply.pain':        '好難過你唔舒服。記得同身邊親近嘅人講一聲。平時呢啲時候，有咩可以令你舒服啲？',
    'reply.lonely.1':    '聽落有啲孤單。你想傾嘅時候，我隨時都喺度。最近掛住邊個呀？',
    'reply.lonely.2':    '我明白嗰種感覺。身邊冇人嘅時候，你隨時都可以搵我傾偈。你想傾啲咩？',
    'reply.good.who':    '聽到你{who}嘅事真好！你哋一齊做咗啲咩呀？',
    'reply.good.1':      '聽到就開心。係咩令佢咁好呀？',
    'reply.good.2':      '真係替你高興。發生咗咩事呀？',
    'reply.who':         '同我講下你{who}啦。佢係個點樣嘅人呀？',
    'reply.remember':    '我好想聽多啲。你記得最清楚嘅係咩呀？',
    'reply.no.topic':    '唔緊要。不如同我傾下「{topic}」？',
    'reply.no.plain':    '唔緊要，想傾咩都得，或者就唞下。',
    'reply.offerStop':   '完全唔緊要，而家唔一定要傾。今日就傾到呢度，好唔好？',
    'reply.memory':      '咁令我諗起你講過：「{mem}」。可唔可以講多少少？',
    'reply.open.1':      '最近心入面諗緊啲咩呀？',
    'reply.open.2':      '呢個星期有冇啲咩令你好期待？',
    'reply.open.3':      '最近有冇啲咩令你笑咗出嚟？',
    'reply.open.4':      '如果而家可以食任何嘢，你最想食咩呀？',
    'reply.open.day':    '你今日過得點呀？',
    'reply.rest':        '同你傾偈真開心。想再傾嘅時候，我隨時都喺度。',
    'ai.offline':        '我而家諗嘢有啲困難，所以回答可能會簡單啲。',
    'ai.offline.short':  '暫時係簡單回覆',

    'starters.title':    '想傾啲咩？',
    'starter.game':      '今日嘅心情小遊戲',
    'starter.memory':    '你同我講過：「{mem}」。可唔可以同我講多啲？',
    'starter.open.smile': '令你笑嘅事',
    'starter.open.meal':  '最鍾意食嘅餸',
    'starter.open.ahead': '呢個星期嘅打算',
    'starter.open.young': '後生嗰陣',
    'starter.open.place': '你鍾意嘅地方',
    'starter.ask.young':  '你後生嗰陣，有咩開心嘅回憶呀？',
    'starter.ask.place':  '有冇一個你一直都好鍾意嘅地方呀？',

    'story.ch.childhood': '童年',
    'story.ch.school':    '讀書嗰陣',
    'story.ch.work':      '工作',
    'story.ch.love':      '愛情同婚姻',
    'story.ch.family':    '屋企',
    'story.ch.recipes':   '拿手好餸',
    'story.ch.places':    '去過嘅地方',
    'story.ch.lessons':   '人生道理',
    'story.ch.other':     '其他故事',
    'story.topic.childhood': '你嘅童年',
    'story.topic.school':    '你讀書嗰陣',
    'story.topic.work':      '你做嘢嗰啲年',
    'story.topic.love':      '愛情同婚姻',
    'story.topic.family':    '你屋企人',
    'story.topic.recipes':   '你嘅拿手好餸',
    'story.topic.places':    '你去過嘅地方',
    'story.topic.lessons':   '人生教識你嘅嘢',
    'story.topic.other':     '你嘅一個故事',
    'story.ask.childhood': '我好想聽下你細個嘅事。你最早嘅回憶係咩呀？',
    'story.ask.school':    '同我講下你讀書嗰陣啦。你間學校係點㗎？',
    'story.ask.work':      '同我講下你做過嘅工作啦。你第一份工係咩呀？',
    'story.ask.love':      '同我講下你愛過嘅人啦。你哋係點識㗎？',
    'story.ask.family':    '同我講下你屋企人啦。有冇啲好珍貴嘅屋企回憶？',
    'story.ask.recipes':   '同我講下你嘅拿手好餸啦。係點煮㗎？',
    'story.ask.places':    '同我講下一個對你好重要嘅地方啦。你記得嗰度啲咩？',
    'story.ask.lessons':   '人生教識咗你啲咩，係你想其他人都知道嘅？',
    'story.ask.other':     '有冇一個你想同我講嘅人生故事？',
    'story.more.1':  '講到呢樣，你仲記得啲咩？',
    'story.more.2':  '嗰陣仲有邊個同你一齊？',
    'story.more.3':  '嗰陣你覺得點？',
    'story.go':      '你繼續講，我聽緊。',
    'story.saved':   '多謝你同我講。我已經將佢記低喺你嘅人生故事入面，喺「{chapter}」嗰章。',
    'story.notnow':  '唔緊要。我哋可以傾下第啲嘢，乜都得。',
    'story.thanks':  '多謝你同我講，聽到好開心。',
    'story.toast.full':    '你嘅人生故事已經滿咗。請喺「我嘅故事」度刪除一個，先加新嘅。',
    'story.suggested':     '聽落好似係你人生故事入面嘅一段。佢喺「我嘅故事」度等緊，想留嘅話可以留低。',
    'story.waiting.title': '傾偈入面嘅故事',
    'story.waiting.intro': '呢啲淨係存喺呢部機度，等你決定。淨係你留低嘅先會放入本書，你嘅中心、連結咗嘅屋企人同護理人員都睇得到。',
    'story.keep':          '放入「{chapter}」',
    'story.dismiss':       '唔要呢個',
    'story.private':       '多謝你信我，同我講呢啲。我冇將佢放入你嘅人生故事書。',
    'story.toast.saved':   '已經記低喺你嘅人生故事 ✓',
    'story.toast.updated': '故事已經更新 ✓',
    'story.toast.removed': '故事已經刪除',
    'story.toast.failed':  '你嘅故事暫時儲存唔到，請遲啲再試。',
    'nav.story':      '我嘅故事',
    'story.title':    '我嘅人生故事',
    'story.intro':    '你同我講嘅故事，好似一本書咁分章收好。每一個都可以改或者刪除。你嘅中心、你連結咗嘅屋企人同幫你嘅護理人員都睇得到。',
    'story.print':    '列印或者存做 PDF',
    'story.tell':     '講俾我聽',
    'story.write':    '我自己寫',
    'story.empty':    '仲未有故事。',
    'story.edit':     '改',
    'story.remove':   '刪除',
    'story.save':     '儲存',
    'story.cancel':   '取消',
    'story.yours':    '你嘅故事',
    'story.chapter':  '章',
    'story.confirmRemove': '要喺本書度刪除呢個故事嗎？',
    'story.src.story':        '講俾 Techable 聽嘅',
    'story.src.conversation': '嚟自傾偈',
    'story.src.manual':       '你自己寫嘅',
    'story.book':     ({ name }) => (name ? `${name}嘅人生故事` : '我嘅人生故事'),

    'nav.family':        '屋企人',
    'inbox.navLabel':    '屋企人，{n}個新留言',
    'inbox.title':       '屋企人俾你嘅留言',
    'inbox.intro':       '屋企人透過 Techable 俾你嘅留言、錄音同相。每一個喺度淨係你同傳送嘅人打開到。喺傾偈度打開之後，佢就係嗰次傾偈嘅一部分。',
    'inbox.ask':          '{name}想俾留言你。',
    'inbox.ask.relation': '對方話係你嘅{relation}。',
    'inbox.ask.q':        '你識唔識呢個人？',
    'inbox.allow':        '識，顯示留言',
    'inbox.block':        '唔識，封鎖佢',
    'inbox.allowed':      '{name}嘅留言而家會喺度顯示。',
    'inbox.blocked':      '{name}唔可以再俾留言你。',
    'inbox.confirmBlock': '要封鎖{name}嗎？對方嘅留言會刪除，之後亦唔可以再俾你。',
    'inbox.saveFailed':   '暫時儲存唔到，請遲啲再試。',
    'inbox.tapToPlay':    '㩒 ▶ 播放錄音留言。',
    'link.ask':           '{name}想同你嘅帳戶連結。',
    'link.ask.what':      '你同意嘅話，對方可以睇到你嘅資料、傾偈摘要、每日問候同人生故事，仲可以俾留言你。',
    'link.allow':         '識，連結',
    'link.allowed':       '{name}而家同你連結咗。',
    'link.blocked':       '{name}唔可以同你連結，亦唔可以俾留言你。',
    'link.confirmBlock':  '要封鎖{name}嗎？對方唔可以同你連結，亦唔可以俾留言你。',
    'link.title':         '同你連結咗嘅人',
    'link.intro':         '呢啲屋企人帳戶可以睇到你嘅資料、傾偈摘要、每日問候同人生故事。',
    'link.remove':        '移除',
    'link.confirmRemove': '要移除{name}嗎？對方唔會再睇到你嘅資料、傾偈、每日問候同人生故事。',
    'link.removed':       '{name}已經冇再同你連結。',
    'link.loadFailed':    '暫時查唔到邊個同你連結咗。',
    'find.title':         '俾屋企人搵到我',
    'find.intro':         '開咗之後，你嘅屋企人可以喺 Techable 輸入你嘅電郵搵到你，再請求連結。每個請求都由你決定。',
    'find.saved.on':      '而家你嘅屋企人搵得到你。',
    'find.saved.off':     '而家冇人可以用你嘅電郵搵到你。',
    'onb.find':           '俾屋企人搵到我',
    'onb.find.hint':      '咁你嘅屋企人就可以用你嘅電郵搵到你，再請求連結。每個請求都由你決定。',
    'inbox.empty':       '仲未有留言。屋企人透過 Techable 俾你留言、錄音或者相嘅時候，會喺度出現。',
    'inbox.loading':     '載入緊…',
    'inbox.loadFailed':  '屋企人嘅留言暫時載入唔到。',
    'inbox.mediaFailed': '呢段錄音或者張相暫時載入唔到。',
    'inbox.new':         '新',
    'inbox.play':        '▶ 播放',
    'inbox.show':        '🖼 睇相',
    'inbox.read':        '🔊 讀俾我聽',
    'inbox.delete':      '刪除',
    'inbox.confirmDelete': '要刪除呢個留言嗎？刪除之後你同傳送嘅人都睇唔到。',
    'inbox.deleted':     '留言已經刪除',
    'inbox.deleteFailed': '呢個留言暫時刪除唔到。',
    'inbox.who.rel':     '你嘅{relation}{person}',
    'inbox.who.relOnly': '你嘅{relation}',
    'inbox.who.someone': '屋企人',
    'inbox.text.left':   '{who}{when}留咗言俾你。想唔想聽下？',
    'inbox.voice.left':  '{who}{when}留咗一段錄音俾你。想唔想聽下？',
    'inbox.photo.left':  '{who}{when}傳咗張相俾你。想唔想睇下？',
    'inbox.many':        '你有{n}個屋企人嘅新留言。想唔想聽下？',
    'inbox.another':     '仲有一個留言，係{who}嘅。想唔想聽？',
    'inbox.later':       '梗係得。佢會喺「屋企人」度等你。',
    'inbox.says':        '{who}話：「{text}」',
    'inbox.voice.here':  '呢段係{who}嘅錄音留言。',
    'inbox.photo.here':  '呢張係{who}傳嚟嘅相。',
    'inbox.caption':     '留言寫住：「{text}」',
    'inbox.caption.by':  '{person}寫咗：「{text}」',
    'inbox.photoAlt':    '{who}傳嚟嘅相',
    'starter.family':      '{person}嘅留言',
    'starter.family.many': '{n}個屋企人留言',
    'when.morning':   '今朝',
    'when.afternoon': '今日下晝',
    'when.evening':   '今晚',
    'when.yesterday': '琴日',
    'when.day':       '{day}',
    'when.recent':    '最近',
    'rel.daughter': '女', 'rel.son': '仔', 'rel.granddaughter': '孫女', 'rel.grandson': '孫仔',
    'rel.grandchild': '孫', 'rel.wife': '老婆', 'rel.husband': '老公', 'rel.partner': '伴侶',
    'rel.sister': '姊妹', 'rel.brother': '兄弟', 'rel.niece': '姪女', 'rel.nephew': '姪仔',
    'rel.cousin': '表親', 'rel.friend': '朋友', 'rel.neighbour': '鄰居', 'rel.carer': '照顧你嘅人',

    'onb.welcome':    '歡迎嚟到 Techable。我係陪伴你嘅朋友，想多啲認識你。大約一分鐘，每一步都可以跳過。',
    'onb.step':       '第{n}步，總共{total}步',
    'onb.skipAll':    '住先跳過',
    'onb.back':       '上一步',
    'onb.next':       '下一步',
    'onb.start':      '開始傾偈',
    'onb.done':       '完成',
    'onb.lang.title': '我哋講邊種語言？',
    'onb.name.title': '我應該點稱呼你？',
    'onb.name.label': '稱呼',
    'onb.name.hint':  '之後可以喺「關於我」度改。',
    'onb.int.title':  '你鍾意做啲咩？',
    'onb.int.hint':   '鍾意嘅都可以㩒。我會記住，之後可以傾。',
    'onb.int.more':   '仲鍾意啲咩？',
    'onb.int.gardening': '種花',         'onb.int.gardening.topic': '種花',         'onb.int.gardening.mem': '鍾意種花',
    'onb.int.cooking':   '煮飯',         'onb.int.cooking.topic':   '煮飯',         'onb.int.cooking.mem':   '鍾意煮飯',
    'onb.int.music':     '音樂',         'onb.int.music.topic':     '音樂',         'onb.int.music.mem':     '鍾意音樂',
    'onb.int.mahjong':   '麻雀同打牌',   'onb.int.mahjong.topic':   '打麻雀同打牌', 'onb.int.mahjong.mem':   '鍾意打麻雀同打牌',
    'onb.int.walking':   '散步',         'onb.int.walking.topic':   '散步',         'onb.int.walking.mem':   '鍾意散步',
    'onb.int.reading':   '睇書',         'onb.int.reading.topic':   '睇書',         'onb.int.reading.mem':   '鍾意睇書',
    'onb.int.tv':        '電視同電影',   'onb.int.tv.topic':        '睇電視同電影', 'onb.int.tv.mem':        '鍾意睇電視同電影',
    'onb.int.faith':     '信仰同崇拜',   'onb.int.faith.topic':     '信仰',         'onb.int.faith.mem':     '有宗教信仰',
    'onb.int.crafts':    '手作同車衫',   'onb.int.crafts.topic':    '手作同車衫',   'onb.int.crafts.mem':    '鍾意做手作同車衫',
    'onb.int.pets':      '寵物同動物',   'onb.int.pets.topic':      '動物',         'onb.int.pets.mem':      '鍾意寵物同動物',
    'onb.fam.title':  '你屋企有啲咩人？',
    'onb.fam.hint':   '啱嘅都可以㩒。我會記住。',
    'onb.fam.names':  '佢哋嘅名（可以唔填）',
    'onb.fam.children':      '仔女',       'onb.fam.children.mem':      '有仔女',
    'onb.fam.grandchildren': '孫仔孫女',   'onb.fam.grandchildren.mem': '有孫仔孫女',
    'onb.fam.spouse':        '老伴',       'onb.fam.spouse.mem':        '有老伴',
    'onb.fam.siblings':      '兄弟姊妹',   'onb.fam.siblings.mem':      '有兄弟姊妹',
    'onb.fam.friends':       '好朋友',     'onb.fam.friends.mem':       '有好朋友',
    'onb.fam.pet':           '寵物',       'onb.fam.pet.mem':           '有養寵物',
    'onb.centre.title':   '你有冇去社區中心？',
    'onb.centre.intro':   '如果有，揀好中心再申請加入。中心負責人會見到你個名再決定。佢哋同意之後，就好似其他會員咁，中心可以睇同改你嘅資料、回憶、人生故事同表格內容，睇到你嘅傾偈摘要同每日問候，仲可以設定陪伴者點講嘢。',
    'onb.centre.none':    '暫時未有社區中心可以揀。之後可以喺傾偈畫面申請加入。',
    'onb.centre.search':  '用名或者地區搵',
    'onb.centre.ask':     '申請加入',
    'onb.centre.pick':    '請先揀一間中心。',
    'onb.centre.asked':   '已申請 ✓ ——你嘅申請等緊{centre}處理。佢哋嘅回覆會喺傾偈畫面出現。',
    'onb.centre.failed':  '申請暫時傳唔到，請遲啲喺傾偈畫面再試。',
    'onb.centre.member':  '你係{centre}嘅會員。',
    'onb.centre.pending': '你已經申請加入{centre}，等緊佢哋回覆。',
    'onb.centre.cancel':  '取消申請',
    'onb.how.title': 'Techable 點用',
    'onb.how.1':     '㩒「講嘢」或者打字。我會聽、會答，仲可以讀出我嘅回答。',
    'onb.how.2':     '傾偈會自動儲存。傾完㩒「今次傾到呢度」。',
    'onb.how.3':     '「我嘅故事」會好似一本書咁收好你講嘅故事。',
    'onb.how.4':     '「屋企人」度有屋企人俾你嘅留言、錄音同相。',
    'onb.saveFailed': '你嘅回答暫時儲存唔到。之後可以喺「關於我」度補返。',
    'greet.welcome':          '好開心識到你。今日想傾啲咩呀？',
    'greet.welcome.interest': '好開心識到你。你話你鍾意{interest}——最鍾意佢邊樣呀？',
    'centre.label':            '你嘅社區中心',
    'centre.none':             '仲未連接社區中心',
    'centre.none.details':     '揀你嘅中心再申請加入。',
    'centre.choose':           '揀中心',
    'centre.ask':              '申請加入',
    'centre.cancel':           '取消申請',
    'centre.cancelled':        '申請已經取消',
    'centre.confirmCancel':    '要取消加入{centre}嘅申請嗎？',
    'centre.pending.details':  '已申請加入，等緊中心回覆。',
    'centre.declined':         '{centre}暫時加唔到你',
    'centre.declined.details': '你可以申請第二間中心。',
    'centre.notLinked.details': '仲未連接——申請加入之後，中心先睇到你。',
    'centre.connected':        '你嘅帳戶已經連接咗呢間中心。',
    'centre.upcoming':         '就嚟舉行：{what}',

    'guess.family.ask':       '係咪因為{who}就嚟探你呀？',
    'guess.family.who':       '屋企人',
    'guess.family.then':      '咁就好啦。你知唔知佢哋幾時嚟呢？',
    'guess.family.yes':       '好快就到',
    'guess.family.yes.reply': '有件事可以等緊，日子都過得快啲，係咪？',
    'guess.family.no':        '仲未定',
    'guess.family.no.reply':  '就算未定，有件事喺前頭都幾好。呢幾日不如先打個電話？',

    'guess.hobby.ask.activity': '係咪因為你今日有時間{hobby}呀？',
    'guess.hobby.ask.thing':    '係咪因為你今日花咗啲時間喺{hobby}度呀？',
    'guess.hobby.ask':          '係咪因為你今日做咗啲自己鍾意嘅嘢呀？',
    'guess.hobby.then':         '咁就好啦。今日喺呢樣嘢上面用咗唔少時間嗎？',
    'guess.hobby.yes':          '有一段時間',
    'guess.hobby.yes.reply':    '聽落今日過得幾充實。',
    'guess.hobby.no':           '得少少',
    'guess.hobby.no.reply':     '就算得幾分鐘做鍾意嘅嘢，都可以令一日好過啲。',

    'weather.cond.wet':  '落緊雨',
    'weather.cond.fine': '天氣幾好',
    'weather.cond.dull': '天氣麻麻',
    'weather.summary':   '{cond}，大約{temp}度',

    'guess.weather.ask':        '係咪因為今日嘅天氣呀？',
    'guess.weather.then':       '天氣真係會影響心情，係咪？今日出過門未呀？',
    'guess.weather.then.known': '我睇咗一睇，你嗰邊{summary}。今日出過門未呀？',
    'guess.weather.yes':        '出過喇',
    'guess.weather.yes.reply':      '咁就好。抖啖氣，成日都會鬆返啲。',
    'guess.weather.yes.reply.wet':  '呢種天氣都肯出門，好嘢。抖啖氣，心情都會鬆返啲。',
    'guess.weather.no':         '仲未',
    'guess.weather.no.reply':       '遲啲行一小段，或者喺窗邊郁下都得——身體舒服先好。',
    'guess.weather.no.reply.pain':  '就算淨係坐喺開住嘅窗邊幾分鐘，換下景都幾好。',
    'guess.weather.no.reply.wet':   '呢種天氣不如留喺屋企乾爽啲。喺窗邊飲杯熱嘢，聽落好啲。',
    'guess.weather.no.reply.dull':  '今日喺屋企望下就好。你嗰邊有冇一扇景幾靚嘅窗呀？',

    'guess.friends.ask':       '係咪因為你今日同人傾得好開心呀？',
    'guess.friends.then':      '噉樣嘅傾偈好難得。係咪好耐冇聯絡嘅人呀？',
    'guess.friends.yes':       '係呀，好耐冇見',
    'guess.friends.yes.reply': '好耐冇見嗰種傾偈最難得。有人記掛住你，真係好。',
    'guess.friends.no':        '唔係，我哋成日傾',
    'guess.friends.no.reply':  '有個熟悉嘅人可以講下嘢，真係好。',

    'guess.event.ask':       '係咪因為你好期待{event}呀？',
    'guess.event.what':      '就嚟嘅一件事',
    'guess.event.then':      '好快就到喇？',
    'guess.event.yes':       '好快喇',
    'guess.event.yes.reply': '就喺眼前，真係令人開心。',
    'guess.event.no':        '仲要等陣',
    'guess.event.no.reply':  '有件事可以等緊，都係件好事。',

    'guess.sleep.ask':       '係咪因為尋晚瞓得唔好呀？',
    'guess.sleep.then':      '噉成日都會辛苦啲。遲啲會唔會想抖一陣呢？',
    'guess.sleep.yes':       '可能會',
    'guess.sleep.yes.reply': '抖一陣，係對自己好啲嘅做法。',
    'guess.sleep.no':        '應該唔會',
    'guess.sleep.no.reply':  '希望你今晚瞓得安穩啲。如果又瞓唔著，我都喺度——隨時可以傾。',

    'guess.pain.ask.site':  '係咪因為你嘅{site}唔舒服呀？',
    'guess.pain.ask':       '係咪身上邊度唔舒服呀？',
    'guess.pain.then':      '聽到我都心痛。呢件事同人講咗未呢？',
    'guess.pain.yes':       '講咗喇',
    'guess.pain.yes.reply': '有人知就好，可以一齊留意住。',
    'guess.pain.no':        '仲未',
    'guess.pain.no.reply':  '今日就同人講一聲啦——親近嘅人一定想知。我會一直記掛住你。',

    'guess.lonely.ask':       '係咪因為今日太靜、有啲寂寞呀？',
    'guess.lonely.then':      '靜靜哋嘅日子特別長。有冇邊個係你想收到消息嘅呢？',
    'guess.lonely.yes':       '有呀',
    'guess.lonely.yes.reply': '我明白嗰種感覺。方便嘅話就打個電話畀佢哋——如果身邊冇人，你都隨時可以搵我傾，我一直都喺度。',
    'guess.lonely.no':        '又冇',
    'guess.lonely.no.reply':  '噉我都好開心我哋兩個可以傾幾句。',

    'guess.appetite.ask':       '係咪因為唔多想食嘢呀？',
    'guess.appetite.then':      '最近有冇啲食落仲啱口味嘅嘢呢？',
    'guess.appetite.yes':       '有啲',
    'guess.appetite.yes.reply': '咁就好。鍾意嘅小事，值得好好留住。',
    'guess.appetite.no':        '冇喎',
    'guess.appetite.no.reply':  '多謝你話我知。記得同親近嘅人講一聲——都同我講下，你以前最鍾意食咩？',

    'guess.famworry.ask':       '係咪因為你掛住{who}呀？',
    'guess.famworry.who':       '屋企人',
    'guess.famworry.then':      '呢種心情唔好受。對上一次同佢哋傾偈係幾時呢？',
    'guess.famworry.yes':       '唔耐之前',
    'guess.famworry.yes.reply': '就算係噉，都仲會覺得佢哋好遠，係咪？',
    'guess.famworry.no':        '有排喇',
    'guess.famworry.no.reply':  '不如今個星期打個電話畀佢哋。喺嗰之前仲有我——同我講下佢哋係點樣嘅人啦。',

    'guess.quiet.ask':       '今日係咪過得幾靜呀？',
    'guess.quiet.then':      '呢種靜，係咪令人舒服嗰種呢？',
    'guess.quiet.yes':       '幾舒服',
    'guess.quiet.yes.reply': '噉樣嘅日子都幾好。',
    'guess.quiet.no':        '有啲難捱',
    'guess.quiet.no.reply':  '靜嘅日子真係會覺得長，係咪？好彩我哋而家可以傾下。',

    'guess.routine.ask':       '今日同平時嘅日子差唔多嗎？',
    'guess.routine.then':      '日子過得差唔多，你習唔習慣呢？',
    'guess.routine.yes':       '幾習慣',
    'guess.routine.yes.reply': '安穩、熟悉嘅日子，其實好難得。',
    'guess.routine.no':        '唔多習慣',
    'guess.routine.no.reply':  '有啲變化會好啲，係咪？',

    'guess.outing.ask':       '今日出過門未呀？',
    'guess.outing.then':      '你鍾唔鍾意出去行下呢？',
    'guess.outing.yes':       '鍾意',
    'guess.outing.yes.reply': '出去行下，成日嘅感覺都唔同晒。',
    'guess.outing.no':        '唔多鍾意',
    'guess.outing.no.reply':  '喺屋企都好，冇咩唔妥。'
  }

  const PACKS = { en, cmn, yue }

  // ── Understanding the answer ──────────────────────────────────
  //
  // MOOD ORDER. Tested top to bottom, first match wins, so anything that
  // negates a positive word MUST come before the positive word itself.
  // In English "I'm not feeling good" contains "good"; it was read as a happy
  // day and answered with cheerful guesses. The same trap exists in both
  // Chinese packs — 唔好 / 不太好 both contain 好.
  //
  // CJK has no word boundaries, so these are plain substring alternations. No
  // \b anywhere below the English pack: \b between two Han characters never
  // matches, and a pattern that never matches is a pattern that never fires.
  const PATTERNS = {
    en: {
      mood: [
        // "not bad" is a mild positive in English, not a negative. It has to be
        // caught before the negation rule below, which would otherwise read the
        // "bad" and drop the mood two levels.
        { key: 'okay',  re: /\b(not (too )?bad|could be worse|can'?t complain|mustn'?t grumble|nothing to complain about)\b/i },
        // A day spent saying the sleep was bad has to be read before the
        // negation rule below, which sees the "didn't … well" in "I didn't
        // sleep well" and calls the whole day low. Low leans towards
        // loneliness where tired leans towards sleep, so a senior who had
        // just told us they slept badly was asked "Is it because it has felt
        // quiet or lonely today?" as the very first guess, and the day was
        // filed as "Not So Good" instead of "Tired". "I haven't slept well"
        // and "I couldn't sleep well" came out worse still: neither negator
        // is listed below either, so the bare "well" fell all the way through
        // to the positive rule and a sleepless night was answered cheerfully.
        { key: 'tired', re: /\b((did|do|does|have|has|had|could|would)(n'?t| not)|can'?t|cannot|not|never|hardly|barely) (sleep|slept)\b|\bslept (badly|poorly)\b/i },
        // Negated positives. "not feeling good", "don't feel well",
        // "not particularly wonderful", "hardly myself".
        { key: 'low',   re: /\b(not|no|isn'?t|ain'?t|hardly|barely|do(n'?t| not)|did(n'?t| not)|can'?t|cannot|never)\b[^.!?]{0,24}?\b(good|great|well|wonderful|lovely|happy|fine|ok|okay|alright|all right|myself|the best|so good|too good)\b/i },
        // "bad" was not in this list at all. "I'm feeling bad" — as ordinary a
        // sentence as there is — matched nothing, so the check-in answered a
        // senior who had just said they felt bad with "I did not quite catch
        // that", twice, and then gave up on the mood. Reported from a real
        // session, and the same hole swallowed "unwell", "poorly", "ill",
        // "sick" and "fed up".
        //
        // Bare "bad" is safe here only because the okay rule above is tested
        // first and takes "not too bad" / "not bad" off the table before this
        // one ever sees them. Keep it that way.
        { key: 'low',   re: /\b(not (so |too |very |particularly )?(good|great|well|wonderful)|no good|not the best|not myself|bad|badly|awful|terrible|horrible|dreadful|rubbish|rotten|lousy|poorly|unwell|ill|sick|under the weather|in pain|sore|aching|achy|struggling|fed up|down in the dumps|glum|gloomy|stressed|nervous|sad|down|low|blue|unhappy|upset|miserable|rough|lonely|crying|depressed|hurt|angry|cross|worried|anxious|scared|frightened|frustrated|annoyed|irritated|grumpy)\b/i },
        { key: 'tired', re: /\b(tired|exhausted|worn out|sleepy|shattered|no energy|not slept|didn'?t sleep|can'?t sleep|weary|drained)\b/i },
        { key: 'okay',  re: /\b(ok|okay|okey|alright|all right|so so|so-so|fair|middling|same as (usual|always)|nothing special|neutral|average|fine|as usual|the usual)\b/i },
        { key: 'good',  re: /\b(good|great|well|happy|wonderful|lovely|marvellous|marvelous|excellent|fantastic|cheerful|grand|brilliant|better|content|peaceful|delighted)\b/i }
      ],
      // "Not quite" is read before yes/no: "a bit" and "sort of" often sit in
      // the same sentence as a "yes", and the softer reading is the safer one.
      close: /\b(sort of|kind of|kinda|a bit|a little|not quite|almost|partly|partially|somewhat|maybe|perhaps|in a way|more or less)\b/i,
      no:    /\b(no|nope|nah|not really|not at all|wrong|nothing like that|far from it|that'?s not it|guess again|try again)\b/i,
      // Bare "right" is deliberately absent. "right now I'm not feeling well"
      // was being counted as a yes, so a senior saying they felt unwell got
      // "That is good to hear" back.
      yes:   /\b(yes|yeah|yep|yup|correct|that'?s right|you'?re right|quite right|right you are|true|exactly|indeed|i am|i did|i do|it is|that'?s it|spot on|you got it)\b/i,
      // Which way an "okay" day is leaning. Neutral is tested first: "hard to
      // say" contains "hard".
      lean: [
        { key: 'neutral',  re: /\b(ordinary|just ordinary|usual|as usual|the same|much the same|same as (usual|always)|in between|in-between|neither|middling|so so|so-so|average|normal|hard to say|difficult to say|not sure|don'?t know|no idea|can'?t say|either)\b/i },
        { key: 'negative', re: /\b(hard|harder|hard one|difficult|tough|rough|bad|worse|not good|not so good|down|low|sad|heavy|long day|trying)\b/i },
        { key: 'positive', re: /\b(good|better|nice|lovely|alright|fine|pleasant|happy|cheerful|more good|the good)\b/i }
      ],
      // Two halves, and the split is the whole point.
      //
      // The first is anchored to the WHOLE utterance, and it exists because a
      // senior said "stop" and was answered with "I did not quite catch
      // that" — the list had "stop now" and "let's stop" but no bare stop,
      // so the plainest possible way to end a conversation matched nothing.
      // On the second try the check-in silently gave up on the mood, switched
      // to answering conversationally, and never finished or saved. Bare stop
      // CANNOT go in the second half: "I couldn't stop coughing" and "the bus
      // stop" would both end the check-in, and one of those is a symptom.
      //
      // Both halves take a curly apostrophe as well as a straight one. Every
      // alternative here used to spell it ' only, so "that’s all",
      // "I’m done" and "let’s stop" all failed when typed on a phone,
      // which is the keyboard that produces ’ and the device most of
      // these seniors use.
      done: /^\s*(?:please\s+)?(?:stop|enough|done)\s*[.!]*$|\b(that['\u2019]?s all|that is all|that['\u2019]?s it|that['\u2019]?s enough|nothing else|no more|goodbye|bye( now)?|i['\u2019]?m done|i am done|finished|all done|stop now|let['\u2019]?s stop)\b/i,
      concerns: {
        loneliness: /\b(alone|lonely|no one|nobody|by myself|miss(ing)? (them|him|her)|left out|ignored)\b/i,
        // "not feeling well" is the phrase people actually use for feeling
        // physically unwell, and it was not being picked up at all.
        discomfort: /\b(pain|ache|aching|sore|hurts?|dizzy|weak|unwell|poorly|under the weather|not (feeling |been )?well)\b/i,
        sleep:      /\b(not slept|didn'?t sleep|can'?t sleep|awake all night|insomnia)\b/i,
        appetite:   /\b(not eaten|haven'?t eaten|no appetite|not hungry|didn'?t eat)\b/i
      },
      // Substantive-answer detection: mood words and ordinary politeness are
      // stripped, and whatever survives is treated as real content.
      greeting: /^\s*(?:(?:hello|hi|hey)(?:\s+(?:there|dear))?|good\s+(?:morning|afternoon|evening))\b[\s,!.?，。！？:;-]*/i,
      filler: /\b(i|i'?m|am|are|feel|feeling|felt|today|day|a|an|the|is|it|its|was|were|be|been|very|really|quite|bit|little|and|but|so|just|of|to|me|my|you|your|thank|thanks|thankyou|please|yes|no|not|too|much|well|ok|okay|right|now|then|here|there|myself|doing|do|did|about|for|with|at|on|in|as|that|this|have|has|had|suppose|guess|think|maybe|dear|love|hello|hi)\b/gi,
      reason: /\b(because|cos|cause|since|due to|after|when my|my (friend|son|daughter|wife|husband|neighbour|neighbor|knee|back|hip|leg|dog|cat)|nobody|no one|they (said|were|did)|she (said|was)|he (said|was))\b/i,
      // For someone who skips the mood word and goes straight to what happened.
      infer: {
        low:  /\b(mean|nasty|rude|argument|fell out|upset|cried|hurt|worried|scared|miss|died|passed away|ill|sick|pain|alone|lonely)\b/i,
        good: /\b(nice|lovely|enjoyed|visited|laughed|fun|good time|pleased|glad)\b/i
      },
      // ── Ordinary chat (F46) ─────────────────────────────────────
      // Saying goodbye. Narrower than `done` above on purpose: that one is for
      // the check-in, where "that's it" and "no more" mean stop; in a chat
      // they are as likely to mean "you got it" or "there's no more soup".
      bye: /\b(good ?bye|bye( bye| now| for now)?|good ?night|nighty night|see you( later| soon| tomorrow)?|(talk|speak) (to you )?(later|tomorrow|soon)|i('ve| have)? (got|have) to go|i (need|must) to go|gotta go|that'?s (all|enough) for (now|today)|i'?m done for (now|today)|let'?s stop( now| here)?)\b/i,
      // Not knowing, or not wanting to say — an answer in itself.
      unsure: /\b(i (don'?t|do not) know|not sure|no idea|dunno|nothing( much| really| else)?|not much|can'?t think( of anything)?|no reason|whatever)\b/i,
      // Yes to "would you like to play today's mood game?". Only a whole,
      // short answer counts: "ok" is also a mood, and "yes, I feel awful" is a
      // mood that should start the game from that answer instead.
      consent: /^\s*(yes|yeah|yep|yup|ok|okay|sure|alright|all right|go on|why not|please|yes please|let'?s (play|go|do it|try)|i'?d (like|love) (that|to)|sounds (good|fun|nice|lovely)|let'?s play|play)\s*[.!]*\s*$/i,
      game: /\b(game|play|guess)\b/i,
      decline: /\b(no( thanks| thank you)?|not (now|today|really)|maybe later|later|just (chat|talk)|i'?d rather (just )?(chat|talk|not))\b/i,
      // People the senior might talk about. English replies echo the clause
      // back ("your son didn't call you"); the other packs name the person.
      kin: /\b(son|daughter|wife|husband|partner|grandson|granddaughter|grandchild|grandchildren|grandkids|brother|sister|mother|mum|mom|father|dad|friend|neighbour|neighbor|niece|nephew|cousin|carer|nurse|doctor|dog|cat)\b/i,
      urgent: []
    },

    cmn: {
      mood: [
        { key: 'okay',  re: /(还行|還行|还可以|還可以|不算差|没什么好抱怨|沒什麼好抱怨)/ },
        // 很差 / 太差 and the rest, for the same gap English had. Bare 差 is
        // deliberately absent: 差不多 means "about the same", and reading
        // that as a bad day is the misread this list exists to avoid.
        { key: 'low',   re: /(不太好|不好|不大好|不怎么好|不怎麼好|很差|好差|太差|糟糕|糟透|没什么精神|沒什麼精神|不开心|不開心|难过|難過|伤心|傷心|心情差|心情不好|难受|難受|不舒服|不适|不適|生病|病了|沮丧|沮喪|失落|郁闷|鬱悶|担心|擔心|害怕|生气|生氣|孤单|孤單|寂寞|想哭|烦|煩)/ },
        { key: 'tired', re: /(累|疲倦|疲劳|疲勞|没力气|沒力氣|没精神|沒精神|困|想睡|睡不着|睡不著|没睡好|沒睡好|睡得不好)/ },
        { key: 'okay',  re: /(还好|還好|一般|普通|马马虎虎|馬馬虎虎|凑合|湊合|老样子|老樣子|跟平常一样|跟平常一樣|没什么特别|沒什麼特別|过得去|過得去|尚可)/ },
        { key: 'good',  re: /(很好|挺好|真好|不错|不錯|开心|開心|高兴|高興|快乐|快樂|舒服|精神好|好得很|好)/ }
      ],
      close: /(有一点|有一點|有点|有點|差不多|算是|稍微|可能|也许|也許|有些)/,
      no:    /(不是|不對|不对|没有|沒有|不|唔|错了|錯了|再猜|不算)/,
      yes:   /(是的|是啊|是呀|对的|對的|对啊|對啊|没错|沒錯|对|對|是|嗯|好的|正确|正確|猜对了|猜對了)/,
      lean: [
        { key: 'neutral',  re: /(平常|普通|一般|老样子|老樣子|差不多|说不准|說不準|不知道|不清楚|中间|中間|都不是|马马虎虎|馬馬虎虎)/ },
        { key: 'negative', re: /(难过|難過|难|難|辛苦|不好|差|累|不开心|不開心|沉重|漫长|漫長)/ },
        { key: 'positive', re: /(好|不错|不錯|开心|開心|舒服|愉快|偏好)/ }
      ],
      // 停 is matched anywhere, because CJK has no word boundaries to anchor
      // it to — which meant 不停 ("non-stop") ended the check-in. 我不停咳嗽,
      // "I keep coughing", is a symptom being reported, not a request to stop.
      // So 停 counts at the start or after any character but 不. Written as
      // that, not as a lookbehind: Safari before 16.4 (every iPhone and iPad
      // left on iOS 15) cannot parse a lookbehind, and one it cannot parse
      // stops the whole of this file loading (tests/browser-parse.test.mjs).
      // Only ever used with .test(), so matching the character before 停 is
      // harmless.
      greeting: /^\s*(?:您好|你好(?:呀|啊)?|早上好|上午好|下午好|晚上好|早安|午安|晚安)[\s，。！？,.!?:：;-]*/,
      done: /(就这样|就這樣|没有了|沒有了|讲完了|講完了|说完了|說完了|够了|夠了|再见|再見|拜拜|不说了|不說了|(?:^|[^不])停)/,
      concerns: {
        loneliness: /(孤单|孤單|寂寞|一个人|一個人|没有人|沒有人|想念|挂念|掛念|冷清)/,
        discomfort: /(痛|疼|酸|不舒服|头晕|頭暈|没力气|沒力氣|难受|難受|虚弱|虛弱)/,
        sleep:      /(睡不着|睡不著|没睡好|沒睡好|失眠|一整晚醒|睡得不好)/,
        appetite:   /(没胃口|沒胃口|吃不下|不想吃|没吃|沒吃|不饿|不餓)/
      },
      filler: null,
      reason: /(因为|因為|所以|之后|之後|我的|他们|他們|他说|他說|她说|她說|没有人|沒有人)/,
      infer: {
        low:  /(凶|骂|罵|吵架|难过|難過|哭|担心|擔心|害怕|想念|去世|过世|過世|生病|痛|孤单|孤單|寂寞)/,
        good: /(好玩|开心|開心|来看我|來看我|笑|高兴|高興|愉快|探望|聚会|聚會)/
      },
      bye:     /(再见|再見|拜拜|晚安|下次再聊|改天再聊|不聊了|先这样吧|先這樣吧|我要走了)/,
      unsure:  /(不知道|不清楚|没什么|沒什麼|没有什么|沒有什麼|说不上来|說不上來|随便|隨便)/,
      consent: /^\s*(好|好的|好呀|好啊|可以|行|来吧|來吧|玩|玩吧|是的|是|想玩|好啊玩)[。！!.\s]*$/,
      game:    /(游戏|遊戲|猜|玩)/,
      decline: /(不用|不要|不玩|不想玩|下次|改天|聊天就好|不了)/,
      kin:     /(儿子|兒子|女儿|女兒|孙子|孫子|孙女|孫女|外孙|外孫|老公|老婆|丈夫|妻子|太太|妈妈|媽媽|爸爸|哥哥|姐姐|弟弟|妹妹|朋友|邻居|鄰居|孩子)/,
      // Safety cannot be English-only the moment the check-in speaks Mandarin.
      // These run in addition to the English list, never instead of it —
      // speech-to-text output is often a mix of both.
      urgent: [
        { flag: 'fall',       level: 'emergency', re: /(跌倒|摔倒|摔了一跤|跌了一跤|滑倒|我跌|我摔)/ },
        { flag: 'breathing',  level: 'emergency', re: /(喘不过气|喘不過氣|呼吸困难|呼吸困難|喘不上气|喘不上氣|胸口痛|胸痛|心口痛)/ },
        { flag: 'self_harm',  level: 'emergency', re: /(想死|不想活|不想活了|自杀|自殺|了结自己|了結自己|活着没意思|活著沒意思|不想再醒来|不想再醒來|伤害自己|傷害自己)/ },
        { flag: 'abuse',      level: 'urgent',    re: /(打我|欺负我|欺負我|恐吓我|恐嚇我|虐待|拿走我的钱|拿走我的錢|怕他|怕她)/ },
        // 拖累 and 負擔/负担 are how the burden thought is actually said. Kept
        // to the strong forms on purpose: 添麻煩 ("sorry to be a trouble") is
        // ordinary politeness and would escalate half the conversations in the
        // language. Worth a native reader's eye before it is widened.
        { flag: 'burden',     level: 'urgent',    re: /(拖累|累赘|累贅|负累|負累|是个负担|是個負擔|成为负担|成為負擔|白活|多余的人|多餘的人)/ },
        { flag: 'not_eating', level: 'urgent',    re: /(没有吃东西|沒有吃東西|没吃东西|沒吃東西|好几天没吃|好幾天沒吃|没有饭吃|沒有飯吃|没东西吃|沒東西吃)/ },
        { flag: 'bleeding',   level: 'emergency', re: /(流血|出血|血流不止)/ }
      ]
    },

    yue: {
      mood: [
        { key: 'okay',  re: /(唔算差|冇乜好投訴|唔錯得晒|還可以|仲可以)/ },
        // 好差 / 糟糕 / 病咗 — see the note in the Mandarin pack. Bare 差 is left
        // out here too, for 差唔多.
        { key: 'low',   re: /(唔係太好|唔太好|唔好|好差|太差|糟糕|唔開心|唔舒服|唔妥|生病|病咗|難過|傷心|心情差|心情唔好|唔精神|失落|驚|擔心|嬲|寂寞|孤單|想喊|煩)/ },
        { key: 'tired'
          , re: /(攰|好攰|疲倦|冇力|冇精神|眼瞓|瞓唔著|瞓得唔好|冇瞓好)/ },
        { key: 'okay',  re: /(麻麻地|麻麻哋|一般|普通|就咁|咁咁地|老樣子|同平時一樣|冇乜特別|過得去|仲可以)/ },
        { key: 'good',  re: /(好好|幾好|唔錯|開心|高興|快樂|舒服|精神|好呀|好)/ }
      ],
      close: /(有少少|有啲|差唔多|算係|可能|或者|某程度上)/,
      // 冇 and 唔 are bare negators and CJK has no word boundaries, so each
      // of them reached into the word that begins with it. A senior who
      // agreed with "係咪因為尋晚瞓得唔好呀？" by saying 冇錯 ("that's right")
      // had it read as a NO — the concern they had just confirmed was never
      // written down, and on a follow-up question the opposite signal was
      // saved instead. 唔錯 ("not bad") was read as a no as well, though this
      // same pack lists it as a GOOD mood. The lookaheads stop the two bare
      // negators at those compounds; everything else they used to catch, they
      // still catch.
      no:    /(唔係|唔系|唔啱|唔對|冇(?!錯)|冇呀|唔(?!錯)|唔得|錯咗|再猜|唔算)/,
      yes:   /(係呀|係啊|係㗎|冇錯|啱呀|啱晒|對呀|係|啱|嗯|好呀|猜中咗|中咗)/,
      lean: [
        { key: 'neutral',  re: /(平常|普通|一般|老樣子|差唔多|講唔埋|唔知|唔清楚|中間|兩者都唔係|麻麻地|麻麻哋)/ },
        { key: 'negative', re: /(辛苦|難捱|難|唔好|差|攰|唔開心|沉重|好長)/ },
        { key: 'positive', re: /(好|幾好|唔錯|開心|舒服|愉快|偏好)/ }
      ],
      // Same guard as the Mandarin pack, and 唔 as well as 不: 唔停 is how a
      // Cantonese speaker says "non-stop", so 我唔停咳 is a cough, not a
      // goodbye. Written without a lookbehind, for the same reason.
      greeting: /^\s*(?:你好(?:呀|啊)?|早晨(?:呀)?|午安(?:呀)?|晚上好|晚安)[\s，。！？,.!?:：;-]*/,
      done: /(就咁多|冇嘢喇|冇喇|講完喇|講完|夠喇|再見|拜拜|唔講喇|(?:^|[^不唔])停)/,
      concerns: {
        loneliness: /(孤單|寂寞|一個人|冇人|掛住|掛念|冷清)/,
        discomfort: /(痛|酸|唔舒服|頭暈|冇力|辛苦|虛弱)/,
        sleep:      /(瞓唔著|冇瞓好|瞓得唔好|失眠|成晚醒)/,
        appetite:   /(冇胃口|食唔落|唔想食|冇食嘢|唔肚餓)/
      },
      filler: null,
      reason: /(因為|所以|之後|我嘅|佢哋|佢話|佢講|冇人)/,
      infer: {
        low:  /(鬧我|嗌交|嘈交|唔開心|喊|擔心|驚|掛住|過身|病咗|痛|孤單|寂寞)/,
        good: /(好玩|開心|嚟探我|笑|高興|愉快|聚會|飲茶)/
      },
      bye:     /(再見|拜拜|早唞|下次再傾|遲啲再傾|唔傾喇|唔講喇|我要走喇|就咁先)/,
      unsure:  /(唔知|唔清楚|冇乜|冇咩|講唔出|是但|隨便)/,
      consent: /^\s*(好|好呀|好啊|得|可以|嚟啦|玩|係|係呀|想玩|好啊玩)[。！!.\s]*$/,
      game:    /(遊戲|估|玩)/,
      decline: /(唔使|唔要|唔玩|唔想玩|下次|遲啲|傾偈就得|唔喇)/,
      kin:     /(個仔|个仔|個女|个女|女兒|孫仔|孫女|老公|老婆|太太|阿媽|媽媽|阿爸|爸爸|哥哥|家姐|細佬|細妹|朋友|鄰居|仔女)/,
      urgent: [
        { flag: 'fall',       level: 'emergency', re: /(跌倒|跌咗|摔咗|跌親|滑親|仆親|我跌|我摔)/ },
        { flag: 'breathing',  level: 'emergency', re: /(唞唔到氣|唞氣困難|呼吸困難|抖唔到氣|心口痛|胸口痛)/ },
        { flag: 'self_harm',  level: 'emergency', re: /(想死|唔想生存|唔想再生存|自殺|了結自己|生存冇意思|活住冇意思|唔想再醒|傷害自己)/ },
        { flag: 'abuse',      level: 'urgent',    re: /(打我|蝦我|恐嚇我|虐待|攞走我啲錢|攞咗我啲錢|怕佢)/ },
        { flag: 'burden',     level: 'urgent',    re: /(拖累|累贅|負累|係個負擔|成為負擔|白活咗|多餘嘅人)/ },
        { flag: 'not_eating', level: 'urgent',    re: /(冇食過嘢|冇嘢食|冇飯食|幾日冇食|唔記得食飯)/ },
        { flag: 'bleeding',   level: 'emergency', re: /(流血|出血|血流唔停)/ }
      ]
    }
  }

  // ── English: "go on walks" → "going on walks" ─────────────────
  // Turns a phrase that starts with a bare verb into one starting with a
  // gerund, so it can be dropped into a sentence. Anything not obviously a
  // verb is returned untouched: "my rose garden" must stay a noun phrase, and
  // guessing wrong here is worse than not trying.
  //
  // Needed in two places, which is why it sits here rather than in either.
  // app.js uses it when a hobby is captured from the conversation ("I like to
  // go on walks" was stored as "Enjoys go on walks"), and checkin.js uses it
  // again when reading a hobby back out, so records written before the fix
  // still read as English.
  //
  // A dictionary is overkill. The list is the verbs people actually use when
  // they say what they like doing, plus the regular spelling rules.
  const HOBBY_VERBS = new Set([
    'go', 'walk', 'run', 'swim', 'read', 'write', 'cook', 'bake', 'knit', 'sew',
    'sing', 'dance', 'paint', 'draw', 'garden', 'travel', 'drive', 'fish',
    'play', 'listen', 'watch', 'visit', 'talk', 'chat', 'sit', 'rest', 'pray',
    'meet', 'help', 'look', 'take', 'work', 'make', 'do', 'have', 'spend',
    'potter', 'wander', 'stroll', 'ride', 'sail', 'collect', 'grow', 'feed',
    'tend', 'bake', 'solve', 'play'
  ])

  // Irregular enough to be worth stating outright.
  const GERUND_SPECIAL = {
    be: 'being', see: 'seeing', flee: 'fleeing', dye: 'dyeing',
    lie: 'lying', tie: 'tying', die: 'dying', go: 'going', do: 'doing'
  }

  function gerundOf(verb) {
    const v = String(verb).toLowerCase()
    if (GERUND_SPECIAL[v]) return GERUND_SPECIAL[v]
    if (/ing$/.test(v)) return v
    if (/ie$/.test(v)) return v.slice(0, -2) + 'ying'
    // Drop a silent final -e ("bake" → "baking"), but not from -ee/-oe/-ye.
    if (/[^aeiou]e$/.test(v)) return v.slice(0, -1) + 'ing'
    // Double a final consonant after a single vowel ("sit" → "sitting"), which
    // for the one-syllable verbs in the list above is reliable.
    if (/^[^aeiou]*[aeiou][bdgklmnprt]$/.test(v)) return v + v.slice(-1) + 'ing'
    return v + 'ing'
  }

  function toGerund(phrase) {
    const text = String(phrase || '').trim()
    if (!text) return text
    const [first, ...rest] = text.split(/\s+/)
    const word = first.toLowerCase()
    if (/ing$/.test(word)) return text
    if (!HOBBY_VERBS.has(word)) return text
    return [gerundOf(word), ...rest].join(' ')
  }

  // ── Current language ──────────────────────────────────────────
  // Held here rather than read from the resident record on every call, so a
  // check-in cannot change language halfway through because a profile was
  // edited in another tab. app.js sets it when the selected resident changes.
  let current = 'en'
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved && PACKS[saved]) current = saved
  } catch (_) {}

  function normalise(code) {
    const c = String(code || '').toLowerCase()
    if (PACKS[c]) return c
    // Tolerate the codes people actually type into a profile field.
    if (/^(zh[-_]?hk|yue|cantonese|廣東話|广东话|粵語|粤语)/.test(c)) return 'yue'
    if (/^(zh|cmn|mandarin|putonghua|普通話|普通话|國語|国语|中文)/.test(c)) return 'cmn'
    return 'en'
  }

  function set(code) {
    current = normalise(code)
    try { localStorage.setItem(STORE_KEY, current) } catch (_) {}
    return current
  }

  // A senior with no name is ordinary: the name fields on senior-login.html are
  // optional. Every line that addresses them by name then has a hole in it, and
  // both previous answers were wrong in front of the person. Leaving the
  // placeholder printed "Thank you, {name}." on screen. Substituting a filler
  // word — 'there' — printed "Thank you, there." and "That is lovely to hear,
  // there.", and in the other two packs it dropped an English word into the
  // middle of a Chinese sentence: "谢谢您，there。", "多謝你，there。".
  //
  // Every one of these sentences reads correctly with the address simply gone,
  // so take it out along with the punctuation that was holding it open. Three
  // shapes cover all three packs: a trailing vocative ("Thank you, {name}."), a
  // leading one ("{name}，您好。") and a bare one ("Hello {name}.").
  //
  // Scoped to {name} on purpose. Every other placeholder is supplied by a
  // caller that guarantees a value, and a general rule here would quietly
  // reshape sentences nobody has looked at.
  const VOCATIVE = [
    /\s*[,，、]\s*\{name\}/g,     // "Thank you, {name}."
    /\{name\}\s*[,，、]\s*/g,     // "{name}，您好。"
    /\s*\{name\}/g               // "Hello {name}."
  ]

  function dropName(text) {
    return VOCATIVE.reduce((s, re) => s.replace(re, ''), text)
  }

  function fill(text, vars) {
    if (!vars) return text
    const missing = v => v === undefined || v === null || v === ''
    const out = missing(vars.name) && 'name' in vars ? dropName(text) : text
    return out.replace(/\{(\w+)\}/g, (whole, key) =>
      missing(vars[key]) ? whole : String(vars[key]))
  }

  // Missing keys fall through to English rather than rendering blank: half a
  // conversation in the wrong language still beats a silent prompt.
  function pick(key, code) {
    const pack = PACKS[code] || PACKS.en
    return pack[key] !== undefined ? pack[key] : PACKS.en[key]
  }

  function t(key, vars) {
    const v = pick(key, current)
    if (v === undefined) return ''
    return fill(typeof v === 'function' ? v(vars || {}) : String(v), vars)
  }

  // English, whatever the senior is speaking. Used for everything written into
  // the saved record, so one care team can read one dashboard.
  function tEn(key, vars) {
    const v = pick(key, 'en')
    if (v === undefined) return ''
    return fill(typeof v === 'function' ? v(vars || {}) : String(v), vars)
  }

  function has(key) {
    return pick(key, current) !== undefined
  }

  function patterns() {
    return PATTERNS[current] || PATTERNS.en
  }

  // Every language's urgent list, not just the current one. A senior may
  // answer in English on a Cantonese check-in, or the recogniser may return a
  // mix; a disclosure must escalate either way.
  function allUrgent() {
    return Object.values(PATTERNS).flatMap(p => p.urgent || [])
  }

  // Interpolating an English hobby into a Chinese sentence produces something
  // no one speaks. When the value is not in the same script as the pack, the
  // caller is told to use the generic wording instead.
  const HAS_CJK = /[㐀-䶿一-鿿豈-﫿]/

  function fitsScript(value) {
    if (!value) return false
    if (current === 'en') return !HAS_CJK.test(value)
    return HAS_CJK.test(value)
  }

  // Speech recognition wants a single tag and silently ignores an unknown one,
  // so the alternates exist for callers that want to retry.
  function speechLang() {
    const l = BY_CODE[current] || BY_CODE.en
    return l.speech
  }

  function speechLangs() {
    const l = BY_CODE[current] || BY_CODE.en
    return [l.speech, ...(l.speechAlt || [])]
  }

  // Every installed voice that can speak the current language, best match
  // first: the exact tag, then the language family, then the wider fallback.
  // Returned as a list rather than a single pick because which of them sounds
  // human is a separate question from which of them speaks the language, and
  // app.js is what knows the answer to the first one. Empty means the device
  // has no voice for this language at all.
  function voiceCandidates(voices) {
    const l = BY_CODE[current] || BY_CODE.en
    const list = Array.isArray(voices) ? voices : []
    const tags = [l.speech, ...(l.speechAlt || [])].map(s => s.toLowerCase())
    const tagOf = v => String(v.lang || '').toLowerCase().replace(/_/g, '-')

    const exact  = list.filter(v => tags.includes(tagOf(v)))
    const family = list.filter(v => !exact.includes(v) && l.voice.test(tagOf(v)))
    const wider  = l.voiceFallback
      ? list.filter(v => !exact.includes(v) && !family.includes(v) && l.voiceFallback.test(tagOf(v)))
      : []

    return [...exact, ...family, ...wider]
  }

  // Pick an installed voice for the current language. Returns null when the
  // device has none, which is the caller's cue to leave the default alone
  // rather than read Cantonese out in an English voice.
  function pickVoice(voices) {
    return voiceCandidates(voices)[0] || null
  }

  window.TechableI18n = {
    LANGS,
    codes: LANGS.map(l => l.code),
    code: () => current,
    lang: () => BY_CODE[current] || BY_CODE.en,
    label: code => (BY_CODE[normalise(code)] || BY_CODE.en).native,
    normalise,
    set,
    t,
    en: tEn,
    has,
    patterns,
    allUrgent,
    fitsScript,
    speechLang,
    speechLangs,
    pickVoice,
    voiceCandidates,
    toGerund
  }
})()
