/**
 * Cloud Function #1: create-request
 *
 * Эта функция принимает заявку с сайта:
 * 1. Получает POST-запрос с фронта.
 * 2. Определяет тип заявки: звонок, заказ, предзаказ, подбор альтернативы.
 * 3. Отправляет сообщение в Telegram с кнопкой "Принять".
 * 4. Сохраняет заявку в YDB со статусом pending.
 * 5. Кладет request_id в Message Queue, чтобы через 5 минут пришло напоминание.
 */

const {
  Driver,
  getCredentialsFromEnv,
  TypedValues,
} = require('ydb-sdk');

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

/**
 * =========================
 * ENV-ПЕРЕМЕННЫЕ
 * =========================
 *
 * Эти значения задаются в настройках Yandex Cloud Function.
 *
 * TELEGRAM_BOT_TOKEN — токен Telegram-бота.
 * TELEGRAM_CHAT_ID — ID боевого Telegram-чата.
 *
 * YDB_ENDPOINT — endpoint YDB.
 * YDB_DATABASE — путь к базе YDB.
 *
 * YMQ_QUEUE_URL — URL очереди Message Queue.
 * AWS_REGION — регион, обычно ru-central1.
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — статический ключ сервисного аккаунта для Message Queue.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const YDB_ENDPOINT = process.env.YDB_ENDPOINT;
const YDB_DATABASE = process.env.YDB_DATABASE;
const YMQ_QUEUE_URL = process.env.YMQ_QUEUE_URL;

/**
 * Клиент для Yandex Message Queue.
 * YMQ совместим с AWS SQS API, поэтому используется @aws-sdk/client-sqs.
 */
const sqsClient = new SQSClient({
  region: process.env.AWS_REGION || 'ru-central1',
  endpoint: 'https://message-queue.api.cloud.yandex.net',
});

/**
 * YDB driver кэшируется между вызовами функции.
 * Это экономит время на повторное подключение при теплых стартах функции.
 */
let ydbDriverPromise = null;

/**
 * Универсальный JSON-ответ для браузера.
 *
 * Здесь также стоят CORS-заголовки, чтобы функция нормально вызывалась с сайта.
 */
function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(data),
  };
}

/**
 * Экранирование текста для Telegram HTML parse_mode.
 *
 * Нужно, чтобы пользовательские данные не ломали HTML-разметку Telegram.
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Генерируем уникальный ID заявки.
 *
 * По нему:
 * - сохраняем заявку в YDB;
 * - привязываем кнопку Telegram;
 * - кладем задачу в очередь;
 * - потом ищем заявку для напоминания.
 */
function makeRequestId() {
  return `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Нормализуем тип заявки.
 *
 * Чтобы функция не падала от неизвестного type:
 * - если пришел известный тип — используем его;
 * - если type пустой или неизвестный — считаем, что это callback_request.
 *
 * Чтобы добавить новый сценарий:
 * 1. Добавить новый if здесь.
 * 2. Добавить текст сообщения в buildTelegramText.
 * 3. Добавить текст кнопки в getAcceptButtonText.
 * 4. Добавить обработку напоминания в reminder-функции.
 */
function normalizeRequestType(type) {
  if (type === 'one_click_order') return 'one_click_order';
  if (type === 'preorder_request') return 'preorder_request';
  if (type === 'alternative_request') return 'alternative_request';

  return 'callback_request';
}

/**
 * Приводим тело запроса к единому формату.
 *
 * Разные формы могут отправлять разные поля:
 * - обратный звонок: name
 * - заказ в один клик: full_name
 *
 * Поэтому здесь собираем единый объект:
 * requestType, phone, name, comment, pageUrl, productName, productPrice.
 */
function normalizeRequestBody(body) {
  const requestType = normalizeRequestType(body.type);

  const phone = String(body.phone || '').trim();
  const name = String(body.name || body.full_name || '').trim();
  const comment = String(body.comment || '').trim();

  const pageUrl = String(body.page_url || '').trim();
  const productName = String(body.product_name || '').trim();
  const productPrice = String(body.product_price || '').trim();

  const submittedAt = String(
    body.submitted_at ||
    body.submitted_at_local ||
    body.submitted_at_iso ||
    ''
  ).trim();

  return {
    requestType,
    phone,
    name,
    comment,
    pageUrl,
    productName,
    productPrice,
    submittedAt,
  };
}

/**
 * Подключение к YDB.
 *
 * Авторизация идет через сервисный аккаунт функции:
 * authService: getCredentialsFromEnv()
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
 * Сохраняем заявку в YDB.
 *
 * Статус новой заявки всегда pending.
 * Когда менеджер нажмет кнопку "Принять", вторая функция поменяет статус на accepted.
 */
async function saveRequestToYdb(data) {
  const driver = await getYdbDriver();

  await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;
      DECLARE $request_type AS Utf8;
      DECLARE $status AS Utf8;
      DECLARE $phone AS Utf8;
      DECLARE $name AS Utf8;
      DECLARE $comment AS Utf8;
      DECLARE $page_url AS Utf8;
      DECLARE $product_name AS Utf8;
      DECLARE $product_price AS Utf8;
      DECLARE $message_id AS Utf8;
      DECLARE $created_at AS Utf8;

      UPSERT INTO callback_requests (
        request_id,
        request_type,
        status,
        phone,
        name,
        comment,
        page_url,
        product_name,
        product_price,
        message_id,
        created_at
      )
      VALUES (
        $request_id,
        $request_type,
        $status,
        $phone,
        $name,
        $comment,
        $page_url,
        $product_name,
        $product_price,
        $message_id,
        $created_at
      );
    `;

    const params = {
      $request_id: TypedValues.utf8(data.request_id),
      $request_type: TypedValues.utf8(data.request_type),
      $status: TypedValues.utf8(data.status),
      $phone: TypedValues.utf8(data.phone),
      $name: TypedValues.utf8(data.name),
      $comment: TypedValues.utf8(data.comment || ''),
      $page_url: TypedValues.utf8(data.page_url || ''),
      $product_name: TypedValues.utf8(data.product_name || ''),
      $product_price: TypedValues.utf8(data.product_price || ''),
      $message_id: TypedValues.utf8(data.message_id || ''),
      $created_at: TypedValues.utf8(data.created_at),
    };

    await session.executeQuery(query, params);
  });
}

/**
 * Кладем request_id в Message Queue.
 *
 * Очередь настроена с задержкой доставки 300 секунд.
 * Через 5 минут trigger вызовет reminder-функцию.
 *
 * В очередь кладем только request_id.
 * Все подробности заявки reminder-функция потом сама достанет из YDB.
 */
async function sendReminderToQueue({ requestId }) {
  if (!YMQ_QUEUE_URL) {
    throw new Error('YMQ_QUEUE_URL is not set');
  }

  const command = new SendMessageCommand({
    QueueUrl: YMQ_QUEUE_URL,
    MessageBody: JSON.stringify({
      request_id: requestId,
    }),
  });

  await sqsClient.send(command);
}

/**
 * Формируем текст Telegram-сообщения.
 *
 * Здесь можно менять:
 * - заголовки сообщений;
 * - эмоджи;
 * - порядок строк;
 * - какие поля показывать для каждого типа заявки.
 */
function buildTelegramText({
  requestType,
  phone,
  name,
  comment,
  pageUrl,
  productName,
  productPrice,
}) {
  /**
   * Заказ в один клик.
   */
  if (requestType === 'one_click_order') {
    const lines = [
      '❗ <b>Новый заказ в один клик</b>',
      '',
      '<b>Данные о клиенте:</b>',
      `ФИО: ${escapeHtml(name || 'не указано')}`,
      `Телефон: ${escapeHtml(phone)}`,
      `Комментарий: ${escapeHtml(comment || 'не указан')}`,
      '',
      '<b>Данные о товаре:</b>',
      `Товар: ${escapeHtml(productName || 'не указан')}`,
      `Цена: ${escapeHtml(productPrice || 'не указана')}`,
      '',
    ];

    if (pageUrl) {
      lines.push(`<b>Страница:</b> ${escapeHtml(pageUrl)}`);
    }

    return lines.join('\n');
  }

  /**
   * Предзаказ товара.
   */
  if (requestType === 'preorder_request') {
    return [
      '📦 <b>Новая заявка на предзаказ</b>',
      '',
      `<b>Имя:</b> ${escapeHtml(name || 'не указано')}`,
      `<b>Телефон:</b> ${escapeHtml(phone)}`,
      '',
      `<b>Товар:</b> ${escapeHtml(productName || 'не указан')}`,
    ].join('\n');
  }

  /**
   * Подбор альтернативы для товара не в наличии.
   */
  if (requestType === 'alternative_request') {
    return [
      '🔎 <b>Новая заявка на подбор альтернативы</b>',
      '',
      `<b>Имя:</b> ${escapeHtml(name || 'не указано')}`,
      `<b>Телефон:</b> ${escapeHtml(phone)}`,
      '',
      `<b>Товар:</b> ${escapeHtml(productName || 'не указан')}`,
    ].join('\n');
  }

  /**
   * Обратный звонок.
   * Это тип по умолчанию.
   */
  return [
    '📞 <b>Новая заявка на обратный звонок</b>',
    '',
    `<b>Имя:</b> ${escapeHtml(name || 'не указано')}`,
    `<b>Телефон:</b> ${escapeHtml(phone)}`,
    '',
    `<b>Страница:</b> ${escapeHtml(pageUrl || 'не указана')}`,
  ].join('\n');
}

/**
 * Текст кнопки в Telegram.
 *
 * callback_data всегда содержит requestId.
 * По нему вторая функция поймет, какую заявку принять.
 */
function getAcceptButtonText(requestType) {
  if (requestType === 'one_click_order') return '✅ Принять заказ';
  if (requestType === 'preorder_request') return '✅ Принять предзаказ';
  if (requestType === 'alternative_request') return '✅ Принять подбор';

  return '✅ Принять звонок';
}

/**
 * Отправка Telegram-сообщения с inline-кнопкой.
 *
 * Важно:
 * - parse_mode: HTML, поэтому используем <b>...</b>;
 * - disable_web_page_preview: true, чтобы ссылки не раскрывались превью;
 * - callback_data: accept:<requestId>, это обработает вторая функция.
 */
async function sendTelegramMessage({
  requestId,
  requestType,
  phone,
  name,
  comment,
  pageUrl,
  productName,
  productPrice,
}) {
  const text = buildTelegramText({
    requestType,
    phone,
    name,
    comment,
    pageUrl,
    productName,
    productPrice,
  });

  const buttonText = getAcceptButtonText(requestType);

  const tgResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: buttonText,
              callback_data: `accept:${requestId}`,
            },
          ],
        ],
      },
    }),
  });

  const tgResult = await tgResponse.json().catch(() => null);

  if (!tgResponse.ok) {
    console.error('Telegram send failed:', tgResult);
    throw new Error('Telegram request failed');
  }

  return tgResult;
}

/**
 * Главная точка входа Yandex Cloud Function.
 *
 * Entry point должен быть:
 * index.handler
 */
module.exports.handler = async function (event) {
  try {
    /**
     * CORS preflight-запрос от браузера.
     */
    if (event.httpMethod === 'OPTIONS') {
      return jsonResponse(200, { ok: true });
    }

    /**
     * Функция принимает только POST.
     */
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, {
        ok: false,
        error: 'Method not allowed',
      });
    }

    /**
     * Парсим JSON-тело запроса.
     */
    const body = event.body ? JSON.parse(event.body) : {};

    const {
      requestType,
      phone,
      name,
      comment,
      pageUrl,
      productName,
      productPrice,
    } = normalizeRequestBody(body);

    /**
     * Телефон — единственное обязательное поле.
     */
    if (!phone) {
      return jsonResponse(400, {
        ok: false,
        error: 'Phone is required',
      });
    }

    const requestId = makeRequestId();
    const createdAt = new Date().toISOString();

    /**
     * 1. Сначала отправляем заявку в Telegram.
     *
     * Если Telegram не принял сообщение — возвращаем ошибку.
     */
    const tgResult = await sendTelegramMessage({
      requestId,
      requestType,
      phone,
      name,
      comment,
      pageUrl,
      productName,
      productPrice,
    });

    const messageId = String(tgResult?.result?.message_id || '');

    /**
     * 2. Сохраняем заявку в YDB.
     *
     * Ошибку YDB не пробрасываем наверх, чтобы клиент не видел "ошибка отправки",
     * если Telegram уже получил заявку.
     */
    let ydbSaved = false;

    try {
      await saveRequestToYdb({
        request_id: requestId,
        request_type: requestType,
        status: 'pending',
        phone,
        name,
        comment,
        page_url: pageUrl,
        product_name: productName,
        product_price: productPrice,
        message_id: messageId,
        created_at: createdAt,
      });

      ydbSaved = true;
    } catch (ydbError) {
      console.error('YDB save failed:', ydbError.message);
    }

    /**
     * 3. Кладем request_id в Message Queue.
     *
     * Через 5 минут reminder-функция проверит статус заявки.
     */
    let queueSent = false;

    try {
      await sendReminderToQueue({
        requestId,
      });

      queueSent = true;
    } catch (queueError) {
      console.error('YMQ send failed:', queueError.message);
    }

    /**
     * Возвращаем успешный ответ сайту.
     *
     * ydb_saved и queue_sent полезны для отладки.
     */
    return jsonResponse(200, {
      ok: true,
      message: 'request_sent',
      request_id: requestId,
      request_type: requestType,
      ydb_saved: ydbSaved,
      queue_sent: queueSent,
    });
  } catch (error) {
    console.error('Create request failed:', error.message);

    return jsonResponse(500, {
      ok: false,
      error: 'Internal server error',
      message: error.message,
    });
  }
};
