/**
 * Cloud Function #2: accept-request
 *
 * Эта функция принимает webhook от Telegram.
 *
 * Когда менеджер нажимает inline-кнопку “Принять”:
 * 1. Telegram отправляет callback_query в эту функцию.
 * 2. Функция достает request_id из callback_data.
 * 3. Читает тип заявки из YDB.
 * 4. Меняет статус заявки: pending → accepted.
 * 5. Сохраняет, кто именно принял заявку.
 * 6. Убирает кнопку из исходного сообщения.
 * 7. Отправляет в Telegram сообщение “Звонок принят / Заказ принят / ...”.
 */

const {
  Driver,
  getCredentialsFromEnv,
  TypedValues,
} = require('ydb-sdk');

/**
 * =========================
 * ENV-ПЕРЕМЕННЫЕ
 * =========================
 *
 * TELEGRAM_BOT_TOKEN — токен Telegram-бота.
 * TELEGRAM_CHAT_ID — ID Telegram-чата.
 *
 * YDB_ENDPOINT — endpoint YDB.
 * YDB_DATABASE — путь к базе YDB.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const YDB_ENDPOINT = process.env.YDB_ENDPOINT;
const YDB_DATABASE = process.env.YDB_DATABASE;

/**
 * YDB driver кэшируется между вызовами функции.
 */
let ydbDriverPromise = null;

/**
 * Универсальный JSON-ответ.
 *
 * Telegram не требует сложного ответа.
 * Главное — вернуть 200, чтобы webhook считался обработанным.
 */
function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

/**
 * Экранирование текста для Telegram HTML parse_mode.
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Подключение к YDB.
 */
async function getYdbDriver() {
  if (!ydbDriverPromise) {
    const driver = new Driver({
      endpoint: YDB_ENDPOINT,
      database: YDB_DATABASE,
      authService: getCredentialsFromEnv(),
    });

    ydbDriverPromise = driver.ready(10000).then(() => driver);
  }

  return ydbDriverPromise;
}

/**
 * Получаем тип заявки из YDB.
 *
 * Это нужно, чтобы написать не всегда “Звонок принят”,
 * а правильный текст:
 * - Звонок принят
 * - Заказ принят
 * - Предзаказ принят
 * - Подбор принят
 */
async function getRequestTypeFromYdb(requestId) {
  const driver = await getYdbDriver();

  return await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;

      SELECT
        request_type
      FROM callback_requests
      WHERE request_id = $request_id;
    `;

    const params = {
      $request_id: TypedValues.utf8(requestId),
    };

    const result = await session.executeQuery(query, params);
    const rows = result.resultSets?.[0]?.rows || [];

    if (!rows.length) {
      return 'callback_request';
    }

    return rows[0].items[0]?.textValue || 'callback_request';
  });
}

/**
 * Меняем статус заявки на accepted.
 *
 * accepted_by — кто нажал кнопку.
 * accepted_at — когда нажали кнопку.
 */
async function markRequestAccepted({ requestId, acceptedBy, acceptedAt }) {
  const driver = await getYdbDriver();

  await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;
      DECLARE $status AS Utf8;
      DECLARE $accepted_by AS Utf8;
      DECLARE $accepted_at AS Utf8;

      UPDATE callback_requests
      SET
        status = $status,
        accepted_by = $accepted_by,
        accepted_at = $accepted_at
      WHERE request_id = $request_id;
    `;

    const params = {
      $request_id: TypedValues.utf8(requestId),
      $status: TypedValues.utf8('accepted'),
      $accepted_by: TypedValues.utf8(acceptedBy),
      $accepted_at: TypedValues.utf8(acceptedAt),
    };

    await session.executeQuery(query, params);
  });
}

/**
 * Обертка для Telegram Bot API.
 */
async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(`Telegram ${method} failed:`, result);
    throw new Error(`Telegram ${method} failed`);
  }

  return result;
}

/**
 * Текст сообщения после принятия заявки.
 */
function getAcceptedTitle(requestType) {
  if (requestType === 'one_click_order') return 'Заказ принят';
  if (requestType === 'preorder_request') return 'Предзаказ принят';
  if (requestType === 'alternative_request') return 'Подбор принят';

  return 'Звонок принят';
}

/**
 * Главная точка входа Yandex Cloud Function.
 *
 * Entry point:
 * index.handler
 */
module.exports.handler = async function (event) {
  try {
    /**
     * Telegram отправляет тело webhook как JSON.
     */
    const update = event.body ? JSON.parse(event.body) : {};
    const callback = update.callback_query;

    /**
     * Если это не callback_query — просто игнорируем.
     */
    if (!callback) {
      return jsonResponse(200, {
        ok: true,
        ignored: true,
      });
    }

    /**
     * callback_data приходит из кнопки.
     *
     * В первой функции мы создаем кнопку:
     * callback_data: accept:<requestId>
     */
    const data = String(callback.data || '');

    if (!data.startsWith('accept:')) {
      return jsonResponse(200, {
        ok: true,
        ignored: true,
      });
    }

    const requestId = data.replace('accept:', '');

    /**
     * Определяем тип заявки.
     */
    const requestType = await getRequestTypeFromYdb(requestId);
    const acceptedTitle = getAcceptedTitle(requestType);

    /**
     * Определяем, кто нажал кнопку.
     *
     * Если у пользователя есть username — пишем @username.
     * Если нет — пишем имя/фамилию из Telegram.
     */
    const user = callback.from || {};

    const acceptedBy = user.username
      ? `@${user.username}`
      : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'неизвестно';

    const acceptedAt = new Date().toISOString();

    /**
     * Обновляем статус в YDB.
     */
    await markRequestAccepted({
      requestId,
      acceptedBy,
      acceptedAt,
    });

    /**
     * Отвечаем на callback_query.
     *
     * Это нужно, чтобы у менеджера в Telegram не крутилась загрузка на кнопке.
     */
    await telegramApi('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: `${acceptedTitle} ✅`,
      show_alert: false,
    });

    const chatId = callback.message?.chat?.id || CHAT_ID;
    const messageId = callback.message?.message_id;

    /**
     * Убираем кнопку из исходного сообщения,
     * чтобы заявку случайно не приняли повторно.
     */
    if (chatId && messageId) {
      await telegramApi('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [],
        },
      });
    }

    /**
     * Отправляем в чат сообщение, кто принял заявку.
     */
    await telegramApi('sendMessage', {
      chat_id: chatId || CHAT_ID,
      text: `✅ <b>${acceptedTitle}</b>\n\nПринял: ${escapeHtml(acceptedBy)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    return jsonResponse(200, {
      ok: true,
      request_id: requestId,
      request_type: requestType,
      status: 'accepted',
      accepted_by: acceptedBy,
    });
  } catch (error) {
    /**
     * Важно: возвращаем 200 даже при ошибке,
     * чтобы Telegram не пытался бесконечно переотправлять один и тот же callback.
     */
    console.error('Accept request failed:', error.message);

    return jsonResponse(200, {
      ok: false,
      error: error.message,
    });
  }
};
