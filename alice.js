// Логика навыка: решаем, что ответить на реплику пользователя.
import { config } from './config.js';
import { askModel } from './llm.js';
import { getFacts, remember, forget } from './memory.js';

// Реплика целиком совпадает с одним из этих слов: выходим
const EXIT_WORDS = ['хватит', 'стоп', 'выход', 'пока', 'закончить', 'выйди', 'закройся', 'выключись'];
// Эти фразы могут стоять где угодно в реплике: «алиса, выключи навык умник»
const EXIT_PHRASES = ['выключи навык', 'закрой навык', 'выйди из навыка', 'выход из навыка', 'останови навык', 'заверши навык'];
const CONTINUE_WORDS = ['дальше', 'ну', 'ну что', 'ну что там', 'что там', 'продолжай', 'давай', 'готово'];

// Команды самой колонке. Навык их выполнить не может, поэтому выходим и отдаём колонку Алисе.
// Срабатывают только на короткие реплики, чтобы «поставь таймер в питоне» не выкинуло из навыка
const DEVICE_MAX_WORDS = 5;
const QUESTION_WORDS = /(^|\s)(как|что|почему|зачем|где|какой|какая|какие)(\s|$)/;
const DEVICE_COMMANDS = [
  /^(включи|выключи|поставь|запусти|убавь|прибавь|заведи)\s(\S+\s)?(музык|песн|трек|радио|плейлист|громкост|звук|будильник|таймер)/,
  /^(громкость|громче|тише|погромче|потише|сделай (громче|тише)|пауза|следующий трек|предыдущий трек)(\s\S+)?$/,
];

const WAIT_SOUND = '<speaker audio="alice-sounds-things-clock-1.opus">';

// Память разговоров. Для каждого сеанса храним:
//   history: все реплики (пользователя и модели)
//   pendingAnswer: ответ, который модель ещё готовит (если не успела вовремя)
//   chunks: недочитанные куски длинного ответа
//   lastSeen: когда пользователь говорил в последний раз
const dialogs = new Map();

function getDialog(sessionId) {
  if (!dialogs.has(sessionId)) {
    dialogs.set(sessionId, { history: [], pendingAnswer: null, chunks: [], lastSeen: 0 });
  }
  const dialog = dialogs.get(sessionId);
  dialog.lastSeen = Date.now();
  return dialog;
}

// Раз в минуту забываем разговоры, в которых давно молчат
setInterval(() => {
  const now = Date.now();
  for (const [id, dialog] of dialogs) {
    if (now - dialog.lastSeen > config.dialogTtlMs) dialogs.delete(id);
  }
}, 60 * 1000).unref();

// Главная функция: получает запрос от Алисы, возвращает ответ
export async function makeAnswer(alice) {
  const sessionId = alice.session.session_id;
  const userId = alice.session.user?.user_id || alice.session.application?.application_id;
  const userText = (alice.request.original_utterance || '').trim();
  const command = normalize(alice.request.command || '');
  const dialog = getDialog(sessionId);

  // 1. Яндекс иногда проверяет, жив ли навык
  if (userText === 'ping') {
    return say('pong');
  }

  // 2. Навык только что запустили
  if (alice.session.new && !userText) {
    return say('Привет! Я на связи, спрашивай что угодно.');
  }

  // 3. Пользователь хочет выйти
  if (EXIT_WORDS.includes(command) || EXIT_PHRASES.some((p) => hasPhrase(command, p))) {
    dialogs.delete(sessionId);
    return { text: 'Давай, до связи!', endSession: true };
  }

  // 4. Команда колонке: музыка, громкость, будильник
  if (isDeviceCommand(command)) {
    dialogs.delete(sessionId);
    return { text: 'Это к Алисе, выхожу из навыка. Скажи ещё раз.', endSession: true };
  }

  // 5. Долгая память
  const memoryAnswer = handleMemory(command, userText, userId);
  if (memoryAnswer) {
    return say(memoryAnswer);
  }

  // 6. «Дальше»: дочитываем длинный ответ или отдаём тот, что модель не успела договорить
  if (CONTINUE_WORDS.includes(command)) {
    if (dialog.chunks.length > 0) {
      return sayChunk(dialog);
    }
    if (dialog.pendingAnswer) {
      return deliver(dialog, dialog.pendingAnswer, true);
    }
  }

  // Пустая реплика (кнопка, тишина): в модель не шлём
  if (!userText) {
    return say('Не расслышала, повтори.');
  }

  // 7. Обычный вопрос. Если модель ещё думает над прошлым, встаём в очередь за ним
  dialog.chunks = [];
  const previous = dialog.pendingAnswer || Promise.resolve();
  dialog.pendingAnswer = previous.then(() => askAndRemember(dialog, userText, getFacts(userId)));
  return deliver(dialog, dialog.pendingAnswer, false);
}

// «Запомни, что я стоматолог», «Что ты обо мне помнишь», «Забудь всё»
function handleMemory(command, userText, userId) {
  if (!userId) return null;

  if (/^запомни\s/.test(command)) {
    // Факт берём из исходной фразы, чтобы сохранить регистр и букву ё
    const fact = userText.replace(/^(алиса|алис)[,\s]+/i, '').replace(/^запомни[,\s]+(что[,\s]+)?/i, '').trim();
    if (fact) {
      remember(userId, fact);
      return 'Запомнила.';
    }
  }
  if (/^что ты (обо мне|про меня) (помнишь|знаешь)/.test(command)) {
    const facts = getFacts(userId);
    if (!facts.length) return 'Пока ничего. Скажи «запомни, что…», и запомню.';
    // Не влезаем в лимит Алисы: перечисляем, пока помещается
    let text = 'Я помню, что';
    for (const fact of facts) {
      if (text.length + fact.length + 3 > 1000) break;
      text += ` ${fact};`;
    }
    return text.replace(/;$/, '.');
  }
  if (/^забудь (всё|все|обо мне)/.test(command)) {
    forget(userId);
    return 'Всё забыла.';
  }
  return null;
}

// Ждём ответ модели, но не дольше, чем готова ждать Алиса.
// Успела: отдаём ответ (длинный кусками). Не успела: просим сказать «дальше»
async function deliver(dialog, answerPromise, isRetry) {
  const answer = await waitAtMost(answerPromise, config.waitForAnswerMs);
  if (!answer) {
    return isRetry
      ? say('Ещё чуть-чуть, скажи «дальше».', `${WAIT_SOUND} Ещё чуть-чуть, скажи «дальше».`)
      : say('Секунду, думаю. Скажи «дальше».');
  }
  const chunks = splitIntoChunks(answer, config.chunkSize);
  // Пока ждали, пользователь мог задать новый вопрос, тогда его ответ и куски не трогаем
  if (dialog.pendingAnswer === answerPromise) {
    dialog.pendingAnswer = null;
    dialog.chunks = chunks;
    return sayChunk(dialog);
  }
  return say(chunks[0]);
}

// Отдаём следующий кусок длинного ответа
function sayChunk(dialog) {
  const chunk = dialog.chunks.shift();
  if (dialog.chunks.length > 0) {
    return say(`${chunk} Продолжить? Скажи «дальше».`);
  }
  return say(chunk);
}

// Режем текст по предложениям на куски не длиннее size.
// Слишком длинное предложение режем по словам
function splitIntoChunks(text, size) {
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .flatMap((sentence) => (sentence.length > size ? sentence.split(' ') : [sentence]));
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current + ' ' + sentence).length > size) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Спрашиваем модель и сохраняем вопрос и ответ в историю разговора
async function askAndRemember(dialog, question, facts) {
  dialog.history.push({ role: 'user', content: question });
  try {
    const answer = await askModel(dialog.history, facts);
    dialog.history.push({ role: 'assistant', content: answer });

    // Храним только последние реплики, чтобы запросы не разрастались
    if (dialog.history.length > config.maxHistory) {
      dialog.history = dialog.history.slice(-config.maxHistory);
    }
    return answer;
  } catch (error) {
    console.error('✗', error.message);
    dialog.history.pop(); // убираем вопрос, на который не ответили
    return 'Не получилось достучаться до модели, попробуй ещё раз.';
  }
}

// «Алиса, дальше!» → «дальше»
function normalize(command) {
  return command
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?«»]/g, '')
    .replace(/^(алиса|алис)\s+/, '')
    .trim();
}

// «Включи музыку», «громкость восемь», но не «как поставить таймер в питоне»
function isDeviceCommand(command) {
  return command.split(' ').length <= DEVICE_MAX_WORDS
    && !QUESTION_WORDS.test(command)
    && DEVICE_COMMANDS.some((re) => re.test(command));
}

// Фраза стоит в реплике целыми словами
function hasPhrase(command, phrase) {
  return ` ${command} `.includes(` ${phrase} `);
}

// Ждём ответ, но не дольше ms миллисекунд. Не дождались: вернём null
function waitAtMost(promise, ms) {
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timer]);
}

// Алиса читает не больше 1024 символов
function say(text, tts) {
  return { text: text.slice(0, 1024), tts: tts?.slice(0, 1024), endSession: false };
}
