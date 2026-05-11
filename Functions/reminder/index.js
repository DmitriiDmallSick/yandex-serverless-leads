/**
 * Cloud Function #3: reminder
 *
 * Эта функция вызывается триггером Yandex Message Queue.
 *
 * Логика:
 * 1. Первая функция create-request кладет request_id в очередь.
 * 2. Очередь ждет 5 минут.
 * 3. Триггер вызывает эту функцию.
 * 4. Функция читает заявку из YDB.
 * 5. Если status = pending — отправляет напоминание в Telegram.
 * 6. Если status = accepted — ничего не делает.
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
 * Подключение к YDB.
 *
 * Авторизация идет через сервисный аккаунт функции.
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
 * Экранирование текста для Telegram HTML parse_mode.
 *
 * Нужно, чтобы пользовательские данные не ломали HTML-разметку.
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Получаем заявку из YDB по request_id.
 *
 * request_id приходит из Message Queue.
 */
async function getRequestFromYdb(requestId) {
  const driver = await getYdbDriver();

  return await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;

      SELECT
        request_id,
        request_type,
        status,
        phone,
        name,
        comment,
        page_url,
        product_name,
        product_price,
        created_at,
        accepted_by,
        accepted_at
      FROM callback_requests
      WHERE request_id = $request_id;
    `;

    const params = {
      $request_id: TypedValues.utf8(requestId),
    };

    const result = await session.executeQuery(query, params);
    const rows = result.resultSets?.[0]?.rows || [];

    if (!rows.length) {
      return null;
    }

    const row = rows[0];

    return {
      request_id: row.items[0]?.textValue || '',
      request_type: row.items[1]?.textValue || 'callback_request',
      status: row.items[2]?.textValue || '',
      phone: row.items[3]?.textValue || '',
      name: row.items[4]?.textValue || '',
      comment: row.items[5]?.textValue || '',
      page_url: row.items[6]?.textValue || '',
      product_name: row.items[7]?.textValue || '',
      product_price: row.items[8]?.textValue || '',
      created_at: row.items[9]?.textValue || '',
      accepted_by: row.items[10]?.textValue || '',
      accepted_at: row.items[11]?.textValue || '',
    };
  });
}

/**
 * Формируем текст напоминания.
 *
 * Здесь можно менять:
 * - заголовки напоминаний;
 * - эмоджи;
 * - структуру сообщений;
 * - какие поля показывать для каждого типа заявки.
 */
function buildReminderText(requestData) {
  /**
   * Заказ в один клик.
   */
  if (requestData.request_type === 'one_click_order') {
    const lines = [
      '🚨 <b>Заказ в один клик не принят 5 минут</b>',
      '',
      '<b>Данные о клиенте:</b>',
      `ФИО: ${escapeHtml(requestData.name || 'не указано')}`,
      `Телефон: ${escapeHtml(requestData.phone)}`,
      `Комментарий: ${escapeHtml(requestData.comment || 'не указан')}`,
      '',
      '<b>Данные о товаре:</b>',
      `Товар: ${escapeHtml(requestData.product_name || 'не указан')}`,
      `Цена: ${escapeHtml(requestData.product_price || 'не указана')}`,
      '',
    ];

    if (requestData.page_url) {
      lines.push(`<b>Страница:</b> ${escapeHtml(requestData.page_url)}`);
    }

    return lines.join('\n');
  }

  /**
   * Предзаказ товара.
   */
  if (requestData.request_type === 'preorder_request') {
    return [
      '🚨 <b>Предзаказ не принят 5 минут</b>',
      '',
      `<b>Имя:</b> ${escapeHtml(requestData.name || 'не указано')}`,
      `<b>Телефон:</b> ${escapeHtml(requestData.phone)}`,
      '',
      `<b>Товар:</b> ${escapeHtml(requestData.product_name || 'не указан')}`,
    ].join('\n');
  }

  /**
   * Подбор альтернативы.
   */
  if (requestData.request_type === 'alternative_request') {
    return [
      '🚨 <b>Подбор альтернативы не принят 5 минут</b>',
      '',
      `<b>Имя:</b> ${escapeHtml(requestData.name || 'не указано')}`,
      `<b>Телефон:</b> ${escapeHtml(requestData.phone)}`,
      '',
      `<b>Товар:</b> ${escapeHtml(requestData.product_name || 'не указан')}`,
    ].join('\n');
  }

  /**
   * Обратный звонок.
   * Это тип по умолчанию.
   */
  return [
    '🚨 <b>Звонок не принят 5 минут</b>',
    '',
    `<b>Имя:</b> ${escapeHtml(requestData.name || 'не указано')}`,
    `<b>Телефон:</b> ${escapeHtml(requestData.phone)}`,
    '',
    `<b>Страница:</b> ${escapeHtml(requestData.page_url || 'не указана')}`,
  ].join('\n');
}

/**
 * Отправляем напоминание в Telegram.
 */
async function sendTelegramReminder(requestData) {
  const text = buildReminderText(requestData);

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error('Telegram reminder failed:', result);
    throw new Error('Telegram reminder failed');
  }

  return result;
}

/**
 * Достаем request_id из события Message Queue.
 *
 * Yandex Message Queue trigger передает сообщения в event.messages.
 * В body каждого сообщения лежит JSON, который мы положили из первой функции:
 *
 * {
 *   "request_id": "lead_..."
 * }
 */
function extractRequestIdsFromEvent(event) {
  const messages = event.messages || [];
  const requestIds = [];

  for (const message of messages) {
    try {
      const body = JSON.parse(message.details?.message?.body || '{}');

      if (body.request_id) {
        requestIds.push(body.request_id);
      }
    } catch (error) {
      console.error('Failed to parse queue message body:', error.message);
    }
  }

  return requestIds;
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
     * Получаем все request_id из сообщений очереди.
     *
     * Обычно batch size = 1, но код поддерживает и несколько сообщений.
     */
    const requestIds = extractRequestIdsFromEvent(event);

    for (const requestId of requestIds) {
      /**
       * Читаем актуальное состояние заявки из YDB.
       */
      const requestData = await getRequestFromYdb(requestId);

      if (!requestData) {
        console.error('Request not found:', requestId);
        continue;
      }

      /**
       * Главное условие:
       *
       * Если заявку уже приняли — ничего не отправляем.
       * Если заявка все еще pending — шлем напоминание.
       */
      if (requestData.status === 'pending') {
        await sendTelegramReminder(requestData);
      }
    }

    /**
     * Возвращаем 200.
     *
     * Если функция успешно обработала сообщение,
     * Message Queue trigger удалит его из очереди.
     */
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        processed: requestIds.length,
      }),
    };
  } catch (error) {
    /**
     * Если здесь вернуть 500, сообщение может вернуться в очередь
     * и триггер попробует обработать его снова.
     */
    console.error('Reminder function failed:', error.message);

    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: 'Internal server error',
        message: error.message,
      }),
    };
  }
};
