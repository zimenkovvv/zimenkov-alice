// Общение с нейросетью: отправляем историю разговора, получаем ответ.
import { config } from './config.js';

// Спрашиваем основную модель. Если она ответила ошибкой, пробуем запасную.
// facts: что мы знаем о пользователе (попадёт в инструкцию для модели)
export async function askModel(history, facts = []) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(facts) },
    ...history,
  ];

  try {
    return await callModel(config.model, messages, config.reasoningEffort);
  } catch (error) {
    if (!config.fallbackModel || config.fallbackModel === config.model) {
      throw error;
    }
    console.error('✗', error.message, `→ пробую ${config.fallbackModel}`);
    // reasoning_effort запасной не шлём: не все модели его понимают
    return await callModel(config.fallbackModel, messages);
  }
}

function buildSystemPrompt(facts) {
  const parts = [config.systemPrompt, config.deviceRule];
  const allFacts = [config.userFacts, ...facts].filter(Boolean);
  if (allFacts.length > 0) {
    parts.push(`Что ты знаешь о собеседнике: ${allFacts.join('; ')}.`);
  }
  return parts.join('\n');
}

async function callModel(model, messages, reasoningEffort) {
  const startedAt = Date.now();

  const request = {
    model,
    messages,
    // Максимальная длина ответа (с запасом: сюда входят и «размышления» модели)
    max_completion_tokens: 1500,
  };
  if (reasoningEffort) {
    request.reasoning_effort = reasoningEffort;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    // Шлюз может зависнуть: без таймаута навык ждал бы ответ вечно
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Модель ${model} вернула ошибку ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const answer = cleanForSpeech(data.choices?.[0]?.message?.content || '');
  if (!answer) {
    throw new Error(`Модель ${model} вернула пустой ответ`);
  }

  console.log(`← (${Date.now() - startedAt} мс, ${model}) ${answer}`);
  return answer;
}

// Убираем то, что колонка не сможет нормально прочитать вслух:
// звёздочки, решётки, ссылки, маркеры списков
function cleanForSpeech(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [текст](ссылка) → текст
    .replace(/[*_`#>]/g, '')                // markdown-символы
    .replace(/^\s*[-•]\s+/gm, '')           // маркеры списков
    .trim();
}
