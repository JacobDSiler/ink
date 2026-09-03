/* Ink — template library and campaign playbooks.
 * Shared by the app (template picker, planner) and the Worker (auto-drafting nudges).
 * Exposes globalThis.InkTemplates = { TEMPLATES, PLAYBOOKS, byId(), playbookById() }.
 *
 * Template bodies are deliberately "nearly done": the author only edits the
 * [square-bracket] placeholders. {{merge_fields}} are filled per subscriber at send time.
 */
(function (root) {
  var TEMPLATES = [
    // ── Onboarding ───────────────────────────────────────────────────────
    {
      id: 'welcome', name: 'Welcome letter', category: 'Onboarding',
      purpose: 'Welcome a brand-new subscriber, set expectations, deliver any promised freebie, and invite a reply.',
      subject: 'Welcome in, {{first_name}}',
      previewText: 'Here is what to expect from me — and a small gift.',
      body:
        'Hello {{first_name}},\n\n' +
        'Thank you for joining my reader list. You are now among the first to hear about new books, behind-the-scenes notes, and the occasional deal I do not post anywhere else.\n\n' +
        'Here is what you can expect: [one letter a month, never more — usually a story from behind the writing desk, and news when there is news].\n\n' +
        '[If you promised a freebie: Your welcome gift is here → [button: Read the free story](https://example.com/free-story)]\n\n' +
        'One small favour: hit reply and tell me [what kind of stories you love / how you found me]. I read every reply.\n\n' +
        'Warmly,\n{{pen_name}}'
    },
    {
      id: 'welcome-2', name: 'Welcome — the story behind the books', category: 'Onboarding',
      purpose: 'Second welcome email: share the origin story of the series and point to the best place to start reading.',
      subject: 'The story behind [Series Name]',
      previewText: 'Where it all began, and where to start.',
      body:
        '{{first_name}},\n\n' +
        'A few days ago I promised you would hear from me again, so here is the story behind the books.\n\n' +
        '[Two or three short paragraphs: the spark that started the series, the moment it became real, what you hope readers feel.]\n\n' +
        'If you are wondering where to begin, start here:\n\n' +
        '[button: Start with [Book One Title]]({{buy_url}})\n\n' +
        'More soon,\n{{pen_name}}'
    },
    {
      id: 'welcome-3', name: 'Welcome — a question for you', category: 'Onboarding',
      purpose: 'Third welcome email: ask a single question to get replies and learn about the reader; light call to action.',
      subject: 'Can I ask you one thing?',
      previewText: 'A quick question — and a way to help.',
      body:
        'Hi {{first_name}},\n\n' +
        'I write these letters for you, so I would like to know one thing: [what was the last book you could not put down, and why?]\n\n' +
        'Just hit reply. Your answer shapes what I write here next.\n\n' +
        'And if you have already read [Book Title], a short review on [Amazon/Goodreads/Folio] is the single most helpful thing a reader can do for an author. [Leave a review](https://example.com/review)\n\n' +
        'Thank you for being here,\n{{pen_name}}'
    },

    // ── Nurture ──────────────────────────────────────────────────────────
    {
      id: 'monthly-letter', name: 'Monthly letter', category: 'Nurture',
      purpose: 'The regular monthly letter: a personal note, a small story from the writing life, a progress update, and one gentle link.',
      subject: 'From the writing desk — [Month]',
      previewText: 'A note from [place], and what the next book is doing.',
      body:
        'Dear {{first_name}},\n\n' +
        '[Open with a small, concrete moment from this month — the weather, a walk, something a character did that surprised you.]\n\n' +
        '## Where the book is\n\n' +
        '[Two or three honest sentences on progress: what is written, what is fighting you, what is next.]\n\n' +
        '## One thing worth your time\n\n' +
        '[A recommendation, an excerpt, a piece of the world, or a reader question you answered.]\n\n' +
        'If you have not yet read [Book Title], it is here: [Read it]({{buy_url}})\n\n' +
        'Until next month,\n{{pen_name}}'
    },
    {
      id: 'behind-the-scenes', name: 'Behind the scenes', category: 'Nurture',
      purpose: 'Give readers a look behind the curtain: research, worldbuilding, a deleted scene, or how a character came to be.',
      subject: 'The thing I cut from [Book Title]',
      previewText: 'A scene that never made the final draft.',
      body:
        '{{first_name}},\n\n' +
        'Every book leaves things on the floor. Today I want to show you one of them.\n\n' +
        '[Introduce the deleted scene, research rabbit-hole, or worldbuilding detail, then share it — an excerpt of 200–400 words works well.]\n\n' +
        '> [A short quoted excerpt.]\n\n' +
        '[Close with why it was cut and what it taught you about the story.]\n\n' +
        '{{pen_name}}'
    },
    {
      id: 'reader-question', name: 'Ask the readers', category: 'Nurture',
      purpose: 'A short email built around one question to readers to drive replies and engagement (covers, titles, what to write next).',
      subject: 'I need your opinion on something',
      previewText: 'Two options. You pick.',
      body:
        'Hi {{first_name}},\n\n' +
        'Quick one. I am deciding [what the next book should be / between two cover directions / a title], and I would rather ask you than guess.\n\n' +
        '**Option A:** [describe]\n\n' +
        '**Option B:** [describe]\n\n' +
        'Hit reply with A or B (and a sentence on why, if you like). I will share the result next letter.\n\n' +
        'Thank you,\n{{pen_name}}'
    },
    {
      id: 're-engage', name: 'Re-engagement (quiet readers)', category: 'Nurture',
      purpose: 'Win back readers who have not opened in months: warm, honest, no guilt, one reason to stay and an easy way to leave.',
      subject: 'Still with me, {{first_name}}?',
      previewText: 'No hard feelings either way.',
      body:
        'Hello {{first_name}},\n\n' +
        'It has been a while since you opened one of my letters, and that is completely fine — inboxes are crowded places.\n\n' +
        'Here is what you have missed: [one line each on two or three things — a new release, a free story, a big change].\n\n' +
        'If you would like to keep hearing from me, you need do nothing at all. If not, the unsubscribe link below works instantly and I will think no less of you.\n\n' +
        'Either way, thank you for reading,\n{{pen_name}}'
    },

    // ── Launch ───────────────────────────────────────────────────────────
    {
      id: 'cover-reveal', name: 'Cover reveal', category: 'Launch',
      purpose: 'Reveal the cover of the upcoming book to the list first, with the release date and a pre-order link.',
      subject: 'You see it first: the cover of [Book Title]',
      previewText: 'Before anyone else.',
      body:
        '{{first_name}}, you are seeing this before anyone else.\n\n' +
        '![Cover of [Book Title]](https://example.com/cover.jpg)\n\n' +
        '[Two sentences on what the cover captures and who made it.]\n\n' +
        '**[Book Title]** releases on **[Date]**. [One-sentence hook for the book.]\n\n' +
        '[button: Pre-order [Book Title]]({{buy_url}})\n\n' +
        'Thank you for being here for it,\n{{pen_name}}'
    },
    {
      id: 'preorder', name: 'Pre-order announcement', category: 'Launch',
      purpose: 'Announce that pre-orders are open, explain why pre-orders matter, and offer a bonus for pre-ordering.',
      subject: 'Pre-orders are open for [Book Title]',
      previewText: 'Plus a bonus for early readers.',
      body:
        'Dear {{first_name}},\n\n' +
        'It is real now: **[Book Title]** is available to pre-order.\n\n' +
        '[Blurb: three or four sentences that sell the story without spoiling it.]\n\n' +
        '[button: Pre-order now]({{buy_url}})\n\n' +
        'Pre-orders matter more than you might think — every one counts toward launch week, which is what gets a book noticed. As thanks, everyone who pre-orders gets [bonus: a short story / signed bookplate / early chapter]. Just reply with your order confirmation.\n\n' +
        'With gratitude,\n{{pen_name}}'
    },
    {
      id: 'first-chapter', name: 'First chapter sneak peek', category: 'Launch',
      purpose: 'Share the opening chapter (or a large excerpt) to build anticipation ahead of release.',
      subject: 'Read the first chapter of [Book Title]',
      previewText: 'No strings. Just the opening.',
      body:
        '{{first_name}},\n\n' +
        'The best way I know to tell you about [Book Title] is to let you read it. Here is how it begins.\n\n' +
        '## Chapter One\n\n' +
        '[Paste the first 600–1200 words, or link to it: [Read Chapter One](https://example.com/chapter-one)]\n\n' +
        '---\n\n' +
        'The rest arrives on **[Date]**. [button: Pre-order [Book Title]]({{buy_url}})\n\n' +
        '{{pen_name}}'
    },
    {
      id: 'launch-day', name: 'Launch day', category: 'Launch',
      purpose: 'Release-day announcement: it is out, here is where to get it, and here is the one thing readers can do to help.',
      subject: '[Book Title] is out today',
      previewText: 'It is finally here.',
      body:
        '{{first_name}} — it is out.\n\n' +
        '**[Book Title]** is available today in [ebook, paperback, and hardback].\n\n' +
        '[button: Get your copy]({{buy_url}})\n\n' +
        '[A short paragraph: what this book means to you, or what readers can expect.]\n\n' +
        'If you would like to help this book find its readers, the two things that matter most are buying it in the first week and leaving an honest review once you have read it. That is truly it.\n\n' +
        'Thank you for every bit of this,\n{{pen_name}}'
    },
    {
      id: 'launch-week-reminder', name: 'Launch week follow-up', category: 'Launch',
      purpose: 'A few days after launch: share early reader reactions, thank buyers, ask for reviews, nudge the undecided.',
      subject: 'What readers are saying about [Book Title]',
      previewText: 'Early words, and a thank-you.',
      body:
        'Hello {{first_name}},\n\n' +
        'It has been [three] days since [Book Title] went out into the world, and I wanted to share a few of the first reactions:\n\n' +
        '> "[Reader quote]" — [Name]\n\n' +
        '> "[Reader quote]" — [Name]\n\n' +
        'If you have read it already: thank you, and a short review would mean the world. [Leave a review](https://example.com/review)\n\n' +
        'If you have not yet: [button: Read [Book Title]]({{buy_url}})\n\n' +
        '{{pen_name}}'
    },

    // ── Crowdfunding ─────────────────────────────────────────────────────
    {
      id: 'ks-prelaunch', name: 'Kickstarter pre-launch', category: 'Crowdfunding',
      purpose: 'Announce an upcoming Kickstarter, explain what backers get, and ask readers to follow the pre-launch page so day one is strong.',
      subject: 'Something is coming: [Project Name] on Kickstarter',
      previewText: 'Follow now, be first on launch day.',
      body:
        'Dear {{first_name}},\n\n' +
        'I have been building something, and you are hearing about it first.\n\n' +
        'On **[Date]** I am launching **[Project Name]** on Kickstarter — [one sentence: what it is and why it exists].\n\n' +
        'Backers will get [special editions / signed copies / exclusive extras]. The best rewards are limited, and the first 48 hours decide whether a campaign takes off.\n\n' +
        'The most helpful thing right now takes ten seconds: follow the pre-launch page so Kickstarter tells you the moment it goes live.\n\n' +
        '[button: Follow on Kickstarter](https://www.kickstarter.com/projects/example)\n\n' +
        'Thank you,\n{{pen_name}}'
    },
    {
      id: 'ks-live', name: 'Kickstarter is live', category: 'Crowdfunding',
      purpose: 'Launch-day Kickstarter email: it is live, early-bird rewards, a direct ask to back now.',
      subject: 'We are live — [Project Name]',
      previewText: 'Early-bird rewards while they last.',
      body:
        '{{first_name}}, it is live.\n\n' +
        '**[Project Name]** is now on Kickstarter, and the early-bird rewards are available for the first [48 hours / 100 backers].\n\n' +
        '[button: Back the project](https://www.kickstarter.com/projects/example)\n\n' +
        '[What backers get, in three short bullet points:]\n\n' +
        '- [Reward one]\n- [Reward two]\n- [Reward three]\n\n' +
        'Every early pledge pushes the project up the Kickstarter rankings, where new readers find it. Thank you for being the first in.\n\n' +
        '{{pen_name}}'
    },
    {
      id: 'ks-final', name: 'Kickstarter final 48 hours', category: 'Crowdfunding',
      purpose: 'Closing push: campaign ends soon, stretch goals or milestones, last chance for rewards.',
      subject: '48 hours left for [Project Name]',
      previewText: 'Last chance for the limited rewards.',
      body:
        'Hello {{first_name}},\n\n' +
        'The [Project Name] campaign closes in **48 hours**. [Where it stands: funded / X% of the way / stretch goal in sight].\n\n' +
        'After [Date] the [special edition / signed copies] will not be available again.\n\n' +
        '[button: Back it before it closes](https://www.kickstarter.com/projects/example)\n\n' +
        'Whether you have backed, shared, or simply read along — thank you. This only happens because of readers like you.\n\n' +
        '{{pen_name}}'
    },

    // ── Promotions ───────────────────────────────────────────────────────
    {
      id: 'sale', name: 'Sale or discount', category: 'Promotion',
      purpose: 'Announce a limited-time discount with a clear deadline and a single call to action.',
      subject: '[Book Title] is [price / 50% off] until [Date]',
      previewText: 'A short window, a good excuse to start.',
      body:
        '{{first_name}},\n\n' +
        'For [the next week / until Sunday], **[Book Title]** is [$0.99 / 50% off / free] [everywhere / on Folio].\n\n' +
        '[One sentence for the reader who has not started, and one for the reader who might gift it.]\n\n' +
        '[button: Get it for [price]]({{buy_url}})\n\n' +
        '[Optional: Use code **[CODE]** at checkout.]\n\n' +
        'The offer ends **[Date]**.\n\n' +
        '{{pen_name}}'
    },
    {
      id: 'free-story', name: 'Free story / reader magnet', category: 'Promotion',
      purpose: 'Deliver a free short story or bonus content as a gift to the list.',
      subject: 'A free story for you, {{first_name}}',
      previewText: 'No catch. Just a story.',
      body:
        'Dear {{first_name}},\n\n' +
        'I wrote a short story set in [the world of the series], and I would like you to have it.\n\n' +
        '[Two sentences: what it is about and where it sits in the timeline.]\n\n' +
        '[button: Read [Story Title]](https://example.com/story)\n\n' +
        'If you enjoy it, tell a friend — the link works for anyone.\n\n' +
        '{{pen_name}}'
    },

    // ── Community ────────────────────────────────────────────────────────
    {
      id: 'arc-call', name: 'Beta / ARC reader call', category: 'Community',
      purpose: 'Recruit advance readers for the next book: what is involved, the timeline, how to sign up.',
      subject: 'Want to read [Book Title] before everyone else?',
      previewText: 'I am looking for a few early readers.',
      body:
        'Hi {{first_name}},\n\n' +
        'I am putting together a small group of early readers for **[Book Title]**, and I would love for you to be one of them.\n\n' +
        'What it involves: you get the book [X weeks] before release, you read it, and you tell me honestly what you think [and post a review on release day, if you are willing].\n\n' +
        'There are [20] places. If you would like one, reply with the word **READER** and I will send the details.\n\n' +
        'Thank you,\n{{pen_name}}'
    },
    {
      id: 'milestone-thanks', name: 'Milestone thank-you', category: 'Community',
      purpose: 'Celebrate a milestone (list size, sales, anniversary, award) and thank readers sincerely, with an optional small gift.',
      subject: 'Thank you — [milestone]',
      previewText: 'This happened because of you.',
      body:
        '{{first_name}},\n\n' +
        'This week [milestone: the list passed 1,000 readers / the book turned one / we hit funding], and I wanted to say thank you properly.\n\n' +
        '[Three sentences: what it means to you, and one specific reader moment that stayed with you.]\n\n' +
        '[Optional gift: As a small thank-you, [free story / discount / bonus] is here → [Claim it](https://example.com)]\n\n' +
        'With real gratitude,\n{{pen_name}}'
    },
    {
      id: 'holiday', name: 'Seasonal greeting', category: 'Community',
      purpose: 'A short seasonal note (holidays, new year) that keeps the relationship warm without selling.',
      subject: 'A small note for the season',
      previewText: 'No links, no asks — just a thank-you.',
      body:
        'Dear {{first_name}},\n\n' +
        '[A short, warm seasonal note — three or four sentences. Something you are grateful for, something you are looking forward to writing.]\n\n' +
        'Thank you for reading along this year.\n\n' +
        'Warmly,\n{{pen_name}}'
    }
  ];

  /* Playbooks: items have offsetDays relative to the plan's anchor date
   * (e.g. launch day, Kickstarter launch, or "today" for nurture plans). */
  var PLAYBOOKS = [
    {
      id: 'nurture-monthly', name: 'Steady nurture (12 months)', anchorLabel: 'First letter date',
      description: 'One letter a month, every month, with a behind-the-scenes piece and a reader question mixed in. The single most effective habit an author can keep.',
      cadence: 'monthly', repeat: true, leadDays: 4,
      items: [
        { offsetDays: 0, templateId: 'monthly-letter', title: 'Monthly letter' },
        { offsetDays: 30, templateId: 'monthly-letter', title: 'Monthly letter' },
        { offsetDays: 60, templateId: 'behind-the-scenes', title: 'Behind the scenes' },
        { offsetDays: 90, templateId: 'monthly-letter', title: 'Monthly letter' },
        { offsetDays: 120, templateId: 'reader-question', title: 'Ask the readers' },
        { offsetDays: 150, templateId: 'monthly-letter', title: 'Monthly letter' },
        { offsetDays: 180, templateId: 'free-story', title: 'Free story' },
        { offsetDays: 210, templateId: 'monthly-letter', title: 'Monthly letter' },
        { offsetDays: 240, templateId: 'behind-the-scenes', title: 'Behind the scenes' },
        { offsetDays: 270, templateId: 'monthly-letter', title: 'Monthly letter' },
        { offsetDays: 300, templateId: 're-engage', title: 'Re-engage quiet readers', segment: 'quiet' },
        { offsetDays: 330, templateId: 'monthly-letter', title: 'Monthly letter' }
      ]
    },
    {
      id: 'book-launch', name: 'Book launch (10 weeks)', anchorLabel: 'Release day',
      description: 'Cover reveal, pre-orders, first chapter, launch day and the follow-up that turns buyers into reviewers.',
      leadDays: 4,
      items: [
        { offsetDays: -63, templateId: 'cover-reveal', title: 'Cover reveal' },
        { offsetDays: -42, templateId: 'preorder', title: 'Pre-orders open' },
        { offsetDays: -28, templateId: 'behind-the-scenes', title: 'Behind the scenes of the book' },
        { offsetDays: -14, templateId: 'first-chapter', title: 'First chapter sneak peek' },
        { offsetDays: -3, templateId: 'monthly-letter', title: 'Three days to go' },
        { offsetDays: 0, templateId: 'launch-day', title: 'Launch day' },
        { offsetDays: 4, templateId: 'launch-week-reminder', title: 'Launch week follow-up' },
        { offsetDays: 21, templateId: 'milestone-thanks', title: 'Thank-you & review ask' }
      ]
    },
    {
      id: 'kickstarter', name: 'Kickstarter campaign (6 weeks)', anchorLabel: 'Campaign launch day',
      description: 'Pre-launch follows, launch-day push, mid-campaign story, final 48 hours, and a thank-you.',
      leadDays: 3,
      items: [
        { offsetDays: -21, templateId: 'ks-prelaunch', title: 'Announce the Kickstarter' },
        { offsetDays: -7, templateId: 'first-chapter', title: 'Sneak peek before launch' },
        { offsetDays: -1, templateId: 'ks-prelaunch', title: 'Launches tomorrow' },
        { offsetDays: 0, templateId: 'ks-live', title: 'Kickstarter is live' },
        { offsetDays: 3, templateId: 'launch-week-reminder', title: 'First backers & progress' },
        { offsetDays: 14, templateId: 'behind-the-scenes', title: 'Mid-campaign story' },
        { offsetDays: 26, templateId: 'ks-final', title: 'Final 48 hours' },
        { offsetDays: 30, templateId: 'milestone-thanks', title: 'Thank-you to backers & readers' }
      ]
    },
    {
      id: 'rewarm', name: 'List re-warm (3 weeks)', anchorLabel: 'Start date',
      description: 'For a list that has gone quiet: three honest letters that rebuild the habit before you ask for anything.',
      leadDays: 3,
      items: [
        { offsetDays: 0, templateId: 're-engage', title: 'Still with me?' },
        { offsetDays: 7, templateId: 'behind-the-scenes', title: 'Something worth opening' },
        { offsetDays: 14, templateId: 'free-story', title: 'A gift, no strings' },
        { offsetDays: 21, templateId: 'reader-question', title: 'Ask the readers' }
      ]
    },
    {
      id: 'promo-week', name: 'Sale week', anchorLabel: 'Sale start date',
      description: 'Announce, remind, close. Three emails around a limited-time price.',
      leadDays: 3,
      items: [
        { offsetDays: 0, templateId: 'sale', title: 'Sale starts' },
        { offsetDays: 4, templateId: 'launch-week-reminder', title: 'Mid-sale reminder' },
        { offsetDays: 6, templateId: 'sale', title: 'Last day' }
      ]
    },
    {
      id: 'arc-team', name: 'Advance reader team (4 weeks)', anchorLabel: 'Release day',
      description: 'Recruit early readers, deliver the book, and remind them on release day.',
      leadDays: 3,
      items: [
        { offsetDays: -28, templateId: 'arc-call', title: 'Call for early readers' },
        { offsetDays: -21, templateId: 'first-chapter', title: 'Deliver the advance copy', segment: 'tag:arc' },
        { offsetDays: 0, templateId: 'launch-day', title: 'Release day — review reminder', segment: 'tag:arc' }
      ]
    }
  ];

  var WELCOME_SEQUENCE = {
    name: 'Welcome sequence', trigger: 'subscribe',
    steps: [
      { delayDays: 0, templateId: 'welcome' },
      { delayDays: 3, templateId: 'welcome-2' },
      { delayDays: 7, templateId: 'welcome-3' }
    ]
  };

  function byId(id) { for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) return TEMPLATES[i]; return null; }
  function playbookById(id) { for (var i = 0; i < PLAYBOOKS.length; i++) if (PLAYBOOKS[i].id === id) return PLAYBOOKS[i]; return null; }

  root.InkTemplates = { TEMPLATES: TEMPLATES, PLAYBOOKS: PLAYBOOKS, WELCOME_SEQUENCE: WELCOME_SEQUENCE, byId: byId, playbookById: playbookById };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
