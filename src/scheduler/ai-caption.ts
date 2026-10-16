import { config, logger } from '../config.js';
import { GeneratedCaptionResult } from '../types.js';

export interface GenerateCaptionOptions {
  topic: string;
  tone?: 'engaging' | 'professional' | 'casual' | 'storytelling' | 'humorous' | 'inspirational' | 'educational' | 'promotional' | string;
  targetAudience?: string;
  includeHashtags?: boolean;
  maxHashtags?: number;
  callToAction?: string;
  mediaType?: 'IMAGE' | 'REEL' | 'CAROUSEL';
}

/**
 * Intelligent AI Caption & Hashtag Generator.
 * Uses configured AI provider if available in environment (e.g. GEMINI_API_KEY or OPENAI_API_KEY),
 * or falls back to built-in structured caption crafting engine without requiring any paid SDKs.
 */
export async function generateInstagramCaption(
  options: GenerateCaptionOptions
): Promise<GeneratedCaptionResult> {
  const tone = (options.tone || 'engaging').toLowerCase();
  const maxTags = Math.min(30, Math.max(1, options.maxHashtags ?? 10));
  const includeTags = options.includeHashtags !== false;
  const mediaType = options.mediaType || 'IMAGE';

  // Check if an external AI provider key is configured
  if (config.geminiApiKey) {
    try {
      logger.info('Using configured Gemini API key for caption generation...');
      return await generateWithGemini(options, tone, maxTags, includeTags);
    } catch (err) {
      logger.warn('Gemini API generation failed, falling back to built-in AI studio:', err instanceof Error ? err.message : String(err));
    }
  }

  if (config.openaiApiKey) {
    try {
      logger.info('Using configured OpenAI API key for caption generation...');
      return await generateWithOpenAi(options, tone, maxTags, includeTags);
    } catch (err) {
      logger.warn('OpenAI API generation failed, falling back to built-in AI studio:', err instanceof Error ? err.message : String(err));
    }
  }

  // Built-in intelligent AI Caption Studio engine
  return generateWithBuiltinStudio(options, tone, maxTags, includeTags, mediaType);
}

/**
 * Built-in AI Caption Studio Engine.
 * Structures high-converting Instagram copy with hook, narrative body, call to action, and strategic hashtags.
 */
function generateWithBuiltinStudio(
  options: GenerateCaptionOptions,
  tone: string,
  maxTags: number,
  includeTags: boolean,
  mediaType: string
): GeneratedCaptionResult {
  const topic = options.topic.trim();
  const audience = options.targetAudience?.trim() || 'our community';

  // 1. Hooks by tone
  const hooks: Record<string, string[]> = {
    professional: [
      `Transforming the way we approach ${topic}.`,
      `The strategic blueprint for ${topic}: What high performers do differently.`,
      `Key insights from our latest work on ${topic}.`,
    ],
    casual: [
      `Quick thoughts on ${topic} today! ✨`,
      `Can we talk about ${topic} for a second? 👀`,
      `Here's what’s really going on with ${topic}. 👇`,
    ],
    storytelling: [
      `A few months ago, I had a realization about ${topic} that changed everything...`,
      `Behind the scenes: The untold story of ${topic}.`,
      `It started as an ordinary day, until ${topic} entered the picture.`,
    ],
    humorous: [
      `Nobody warned me that ${topic} would be like this. 😂`,
      `Current mood: Trying to balance life and ${topic}. ☕`,
      `Raise your hand if ${topic} keeps you up at night too! 🙋‍♂️`,
    ],
    inspirational: [
      `Small steps lead to massive transformations. Embrace ${topic}. ✨`,
      `Your potential with ${topic} is far greater than your doubts. Keep pushing. 🔥`,
      `Never underestimate what happens when you commit to ${topic}. 💫`,
    ],
    educational: [
      `3 things you probably didn't know about ${topic}: 💡`,
      `The beginner-to-pro guide to ${topic} broken down step-by-step:`,
      `Save this! The ultimate checklist for mastering ${topic}. 📌`,
    ],
    promotional: [
      `Exciting announcement! Discover the power of ${topic}. 🚀`,
      `Ready to elevate your game with ${topic}? Here’s what you need to know. 👇`,
      `The wait is over! Elevate your results with ${topic}.`,
    ],
    engaging: [
      `Let's dive into ${topic}! What’s your take? 👇`,
      `Here is why ${topic} matters now more than ever for ${audience}.`,
      `Breaking down ${topic} into actionable insights you can use today. ⚡`,
    ],
  };

  const selectedHooks = hooks[tone] || hooks.engaging;
  const hook = selectedHooks[Math.floor(Math.random() * selectedHooks.length)];

  // 2. Body composition
  let body = '';
  if (tone === 'educational') {
    body = `Here's what we learned:\n1️⃣ Start with a solid foundation.\n2️⃣ Consistency beats intensity every single time.\n3️⃣ Focus on what truly moves the needle for ${audience}.\n\nWhen you master the fundamentals of ${topic}, everything else clicks into place.`;
  } else if (tone === 'storytelling') {
    body = `When we first dove into ${topic}, the path wasn't entirely clear. We experimented, learned from setbacks, and discovered what truly resonates with ${audience}.\n\nThe biggest takeaway? Showing up with intention and authenticity makes all the difference.`;
  } else if (tone === 'promotional') {
    body = `We designed this specifically with ${audience} in mind, ensuring every detail solves a real challenge.\n\n✨ Premium quality\n✨ Seamless execution\n✨ Results you can see and feel`;
  } else if (tone === 'professional') {
    body = `In today's landscape, navigating ${topic} requires both precision and adaptability. By focusing on sustainable practices and high-impact actions, ${audience} can achieve long-term growth.\n\nKey takeaway: Strategic alignment and clear execution are your biggest competitive advantages.`;
  } else {
    body = `Whether you're just starting out or already deep into your journey, navigating ${topic} is all about continuous growth.\n\nTake it one day at a time, celebrate the small wins, and keep your focus on what inspires you and ${audience}.`;
  }

  // 3. Call to Action (CTA)
  const defaultCtas: Record<string, string> = {
    IMAGE: 'Double tap if you agree and save this post for later! ❤️📌',
    REEL: 'Watch till the end and share this with someone who needs to see it! 🚀',
    CAROUSEL: 'Swipe through to see all the details! Which slide spoke to you most? 👉',
  };

  const cta = options.callToAction || defaultCtas[mediaType] || 'Drop your thoughts in the comments below! 👇';

  // 4. Hashtag Generation
  const cleanedTopic = topic.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const hashtagBase = [
    `#${cleanedTopic}`,
    `#${cleanedTopic}tips`,
    `#${cleanedTopic}life`,
    `#${cleanedTopic}community`,
    '#instagramgrowth',
    '#contentcreator',
    '#creativeprocess',
    '#mindsetmatters',
    '#dailyinspiration',
    '#visualsoflife',
    '#explorepage',
    '#instadaily',
    '#trendingnow',
    '#growthmindset',
    '#stayinspired',
    '#creativelife',
    '#innovate',
    '#digitalcreator',
    '#engagement',
    '#communityfirst',
    '#learnandgrow',
    '#successmindset',
    '#reelsinstagram',
    '#aestheticpost',
    '#contentstrategy',
    '#creatorcommunity',
    '#inspirationoftheday',
    '#moderncreatives',
    '#visualstorytelling',
    '#dreambig',
  ];

  const hashtags = includeTags ? hashtagBase.slice(0, maxTags) : [];
  const hashtagBlock = hashtags.length > 0 ? `\n\n.\n.\n.\n${hashtags.join(' ')}` : '';

  const fullText = `${hook}\n\n${body}\n\n${cta}${hashtagBlock}`.trim();

  return {
    caption: `${hook}\n\n${body}\n\n${cta}`,
    hashtags,
    fullText,
    characterCount: fullText.length,
    hashtagCount: hashtags.length,
    tone,
    provider: 'built-in-ai-studio',
    isDraft: true,
    status: 'AI_DRAFT',
    recommendedNextStep:
      'Review and refine this draft. Use create_post_draft to save it persistently, or schedule_post to schedule it for future publication.',
  };
}

async function generateWithGemini(
  options: GenerateCaptionOptions,
  tone: string,
  maxTags: number,
  includeTags: boolean
): Promise<GeneratedCaptionResult> {
  const prompt = `You are an elite Instagram content strategist. Write a high-converting Instagram caption for:
Topic: "${options.topic}"
Tone: ${tone}
Target Audience: ${options.targetAudience || 'General Instagram audience'}
Call to action: ${options.callToAction || 'Engage in comments'}
Include ${maxTags} relevant hashtags: ${includeTags ? 'yes' : 'no'}

Format your response as pure JSON with keys:
{
  "caption": "The main caption text without hashtags",
  "hashtags": ["#tag1", "#tag2", ...]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API HTTP ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleanedJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleanedJson) as { caption: string; hashtags: string[] };

  const hashtags = (parsed.hashtags || []).slice(0, maxTags);
  const fullText = `${parsed.caption}\n\n${hashtags.join(' ')}`.trim();

  return {
    caption: parsed.caption,
    hashtags,
    fullText,
    characterCount: fullText.length,
    hashtagCount: hashtags.length,
    tone,
    provider: 'google-gemini',
    isDraft: true,
    status: 'AI_DRAFT',
    recommendedNextStep:
      'Review this AI draft. Use create_post_draft to store it persistently or schedule_post to queue it for publishing.',
  };
}

async function generateWithOpenAi(
  options: GenerateCaptionOptions,
  tone: string,
  maxTags: number,
  includeTags: boolean
): Promise<GeneratedCaptionResult> {
  const prompt = `Write an engaging Instagram caption for:
Topic: "${options.topic}"
Tone: ${tone}
Target Audience: ${options.targetAudience || 'General audience'}
Call to action: ${options.callToAction || 'Default CTA'}
Hashtag count: ${includeTags ? maxTags : 0}

Respond in JSON with:
{
  "caption": "main text without hashtags",
  "hashtags": ["#tag1", ...]
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API HTTP ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content) as { caption: string; hashtags: string[] };

  const hashtags = (parsed.hashtags || []).slice(0, maxTags);
  const fullText = `${parsed.caption}\n\n${hashtags.join(' ')}`.trim();

  return {
    caption: parsed.caption,
    hashtags,
    fullText,
    characterCount: fullText.length,
    hashtagCount: hashtags.length,
    tone,
    provider: 'openai',
    isDraft: true,
    status: 'AI_DRAFT',
    recommendedNextStep:
      'Review this AI draft. Use create_post_draft to store it persistently or schedule_post to queue it for publishing.',
  };
}
