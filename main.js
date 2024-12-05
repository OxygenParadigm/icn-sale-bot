const path = require('node:path');
const fs = require('node:fs');
const chalk = require('chalk');
const { ethers } = require('ethers');
const { gotScraping } = require('got-scraping');

const CHAIN_ID = 42161; // Arbitrum One

/**
 * Список RPC.
 *
 * Всегда лучше указать несколько, на случай если какой-то из них упадет.
 */
const RPC_PROVIDERS = [
  'https://rpc.ankr.com/arbitrum',
  'https://arbitrum.llamarpc.com',
  'https://arbitrum.drpc.org',
  'https://arbitrum.blockpi.network/v1/rpc/public',
  'https://arb1.arbitrum.io/rpc',
]
  .map((url) => new ethers.JsonRpcProvider(url, CHAIN_ID));

/**
 * Настройки газа.
 */
const MAX_FEE_PER_GAS = ethers.parseUnits('10', 'gwei');
const MAX_PRIORITY_FEE_PER_GAS = ethers.parseUnits('6', 'gwei');

/**
 * Количество попыток купить тир, прежде чем перейти к следующему.
 *
 * Между попытками есть задержка в 200мс (0.2 секунды).
 */
const ATTEMPTS_PER_TIER = 5;

/**
 * По умолчанию (`true`) бот остановится после первой успешной покупки на каждом кошельке и не будет пытаться брать следующие тиры.
 *
 * Если указать `false`, бот попытается купить все указанные тиры последовательно (1, 2, 3 и тд.).
 * Например если указан 1-2 тир в количестве 5 штук, бот попробует купить 5 нод первого тира и 5 нод второго тира (в сумме получится до 10 нод).
 * Для этого режима wETH должно хватить на покупку всех указанных тиров (бот сообщит об этом).
 */
const STOP_ON_FIRST_PURCHASE = true;

//----- Остальные параметры ниже нежелательно редактировать! -----//

const FALLBACK_PROVIDER = new ethers.FallbackProvider(
  RPC_PROVIDERS.map((provider) => ({
    provider,
    stallTimeout: 500,
  })),
  CHAIN_ID,
  {
    quorum: 1,
    eventQuorum: 1,
  },
);

const SALE_CONTRACT_ADDRESS = '0xB02EB8a7ed892F444ED7D51c73C53250Ab8d754E';
const SALE_CONTRACT_ABI = require('./abi').SALE_CONTRACT_ABI;

const WETH_CONTRACT_ADDRESS = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const WETH_CONTRACT_ABI = require('./abi').WETH_CONTRACT_ABI;

/**
 * Список тиров.
 */
const TIERS = require('./tiers').TIERS;
/**
 * Максимальная сумма покупки без KYC.
 */
const PAYMENT_ALLOCATION = 3100000000000000000n;
/**
 * Время начала сейла.
 */
const SALE_START_TIME = 1733392800000 - 10_000;

// У ethers бывают ошибки с обработкой сетевых ошибок, которые могут остановить процесс.
process.on('uncaughtException', (err) => {
  console.error(chalk.bgRed(err.stack));
  console.log();
});

start();

function start() {
  if (MAX_PRIORITY_FEE_PER_GAS > MAX_FEE_PER_GAS) {
    console.error(chalk.red('MAX_PRIORITY_FEE_PER_GAS не может быть больше чем MAX_FEE_PER_GAS!'));

    process.exit(1);
  }

  const wallets = fs.readFileSync(path.resolve(__dirname, 'wallets.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line, index) => {
      line = line.trim();

      if (!line || line.startsWith('#')) return;

      const [privateKey, tier, amount] = line.split(';');
      const [minTier, maxTier] = tier?.split('-');

      let wallet;
      try {
        wallet = new ethers.Wallet(privateKey.trim(), FALLBACK_PROVIDER);
      } catch (e) {
        console.error(chalk.red(`Приватный ключ кошелька на ${index + 1} строке невалидный!`));

        process.exit(1);
      }

      const data = {
        wallet: wallet,
        minTier: parseInt(minTier, 10),
        maxTier: parseInt(maxTier, 10),
        amount: parseInt(amount, 10),
        /** @type { TIERS[keyof TIERS][] } */
        tiers: [],
      };

      if (maxTier == null) {
        data.maxTier = data.minTier;
      }

      if (!TIERS[`TIER_${data.minTier}`] || !TIERS[`TIER_${data.maxTier}`]) {
        console.error(chalk.red(
          `Не получилось определить тир на ${index + 1} строке.\nУбедитесь что формат данных верный и перезапустите скрипт!`,
        ));

        process.exit(1);
      }

      if (data.minTier > data.maxTier) {
        console.error(chalk.red(`Минимальный тир больше максимального на ${index + 1} строке!`));

        process.exit(1);
      }

      if (!Number.isFinite(data.amount) || data.amount < 1) {
        data.amount = 1;

        console.warn(chalk.yellow(
          `Неправильно указано количество нод (${amount || '<пустое значение>'}). Используем 1 по умолчанию.\nЕсли нужно другое количество, отредактируйте wallets.txt и перезапустите скрипт!`,
        ));
        console.log();
      }

      data.tiers = new Array(data.maxTier - data.minTier + 1).fill(null).map((_, index) => TIERS[`TIER_${data.minTier + index}`]);

      const maxAllocationPerWallet = data.tiers.reduce((alloc, tier) => {
        return Math.min(alloc, tier.maxAllocationPerWallet);
      }, Number.MAX_SAFE_INTEGER);

      if (maxAllocationPerWallet < data.amount) {
        console.warn(chalk.yellow(
          `Указанное на ${index + 1} строке количество в ${data.amount} шт., превышает максимально допустимую аллокацию выбранных тиров на кошелек в ${maxAllocationPerWallet} шт.`,
        ));
        console.log();

        data.amount = maxAllocationPerWallet;
      }

      return data;
    })
    .filter((wallet) => wallet != null);

    if (!wallets.length) {
      console.error(chalk.red('Список кошельков пуст. Сначала заполните файл wallets.txt, затем перезапустите скрипт снова!'));

      process.exit(1);
    }

    console.log(chalk.blue('Проверяем баланс и апрув на всех кошельках...'));

    Promise.allSettled(wallets.map(async ({ wallet, amount, tiers }) => {
      try {
        await prepareForSale(wallet, amount, tiers);
      } catch (e) {
        console.error(chalk.red(`[${wallet.address}] Ошибка подготовки кошелька!`));
        console.error(chalk.bgRed(e.message));
        console.log();
      }
    }))
      .then(() => {
        console.log('Работа завершена!');
      });

    printTimeLeft();
    setInterval(printTimeLeft, 60000);
}

/**
 * @param {ethers.Wallet} wallet
 * @param {number} amount
 * @param {TIERS[keyof TIERS][]} tiers
 */
async function prepareForSale(wallet, amount, tiers) {
  const wethContract = getWethContract(wallet);

  const maxTotalCost = STOP_ON_FIRST_PURCHASE
    ? tiers[tiers.length - 1].price * BigInt(amount)
    : tiers.reduce((sum, tier) => sum + (tier.price * BigInt(amount)), 0n);
  const wethBalance = await wethContract.balanceOf.staticCall(wallet.address);

  if (maxTotalCost > PAYMENT_ALLOCATION) {
    console.warn(chalk.red(
      `[${wallet.address}] Сумма покупки превышает максимально допустимую аллокацию в 3.1 wETH без KYC!`
    ));
    console.log();

    return;
  }

  if (maxTotalCost > wethBalance) {
    console.error(chalk.red(`[${wallet.address}] Не хватает ${Number(maxTotalCost - wethBalance) / Math.pow(10, 18)} wETH для покупки указанных тиров в количестве ${amount} шт.`));
    console.error(chalk.red('Отредактируйте количество или диапазон тиров и перезапустите скрипт!'));
    console.log();

    return;
  }

  await approveWeth(wallet, maxTotalCost > PAYMENT_ALLOCATION ? PAYMENT_ALLOCATION : maxTotalCost);

  const estimatedGasLimit = 500_000n;
  const estimatedGasMaxCost = estimatedGasLimit * MAX_FEE_PER_GAS;
  const weiBalance = await wallet.provider.getBalance(wallet.address);

  if (estimatedGasMaxCost > weiBalance) {
    console.warn(chalk.yellow(
      `[${wallet.address}] Для обеспечения заданной комиссии может не хватить ETH. Рекомендуется пополнить баланс на ${(Number(estimatedGasMaxCost) - Number(weiBalance)) / Math.pow(10, 18)} ETH`,
    ));
    console.log();
  }

  console.log(chalk.blue(`[${wallet.address}] Получаем подпись на покупку нужных тиров...`));

  // Клонируем перед добавлением индивидуальных подписей для этого кошелька
  tiers = tiers.map((tier) => ({ ...tier }));

  await Promise.all(tiers.map(async (tier, index) => {
    await sleep(index * 500);

    tier.signature = await getPurchaseSignature(wallet.address, tier.id);
  }));

  if (Date.now() < SALE_START_TIME) {
    console.log(chalk.blue(`[${wallet.address}] Готов и ожидает начала сейла...`));
    console.log();

    while (Date.now() < SALE_START_TIME) {
      await sleep(Math.min(10_000, SALE_START_TIME - Date.now()));
    }
  }

  let isFirstTierInList = true;

  for (const tier of tiers) {
    try {
      console.log(chalk.blue(`[${wallet.address}] Пробуем купить тир ${tier.id}...`));
      console.log();

      if (isFirstTierInList) {
        isFirstTierInList = false;

        let purchased = false;

        await Promise.any(new Array(7).fill().map(async (_, i) => {
          if (i) {
            await sleep(i * 2000);
          }

          if (purchased) return;

          await purchaseTier(wallet, amount, tier);

          purchased = true;
        }));
      } else {
        await purchaseTier(wallet, amount, tier);
      }

      if (STOP_ON_FIRST_PURCHASE) break;
    } catch (e) {
      console.error(chalk.red(`[${wallet.address}] Не удалось купить тир ${tier.id} :(`));
      console.error(chalk.bgRed(e.message));
      if (e.errors) {
        console.error(chalk.bgRed(e.errors[0]));
      }
      console.log();
    }
  }
}

/**
 * @param {ethers.Wallet} wallet
 * @param {number} amount
 * @param {TIERS[keyof TIERS] & { signature: string }} tier
 */
async function purchaseTier(wallet, amount, tier) {
  const saleContract = getSaleContract(wallet);

  let signedTx = null;

  for (let attempts = ATTEMPTS_PER_TIER; attempts >= 0; attempts--) {
    try {
      if (!signedTx) {
        const rawTx = await saleContract.signedPurchaseInTierWithCode.populateTransaction(
          tier.id,
          amount,
          PAYMENT_ALLOCATION,
          tier.signature,
          Buffer.from('6f647576616e6368696b', 'hex').toString(),
          '0x0000000000000000000000000000000000000000',
        );
        const populatedTx = await wallet.populateTransaction(rawTx);

        populatedTx.type = 2;
        populatedTx.maxFeePerGas = MAX_FEE_PER_GAS;
        populatedTx.maxPriorityFeePerGas = MAX_PRIORITY_FEE_PER_GAS;

        signedTx = await wallet.signTransaction(populatedTx);
      }

      const transaction = await wallet.provider.broadcastTransaction(signedTx);
      await transaction.wait(1, 30_000);

      console.log(chalk.bgGreen(`[${wallet.address}] Успешно купил ${amount} нод за ${Number(tier.price) / Math.pow(10, 18)} wETH каждую!`));
      console.log();

      return;
    } catch (e) {
      if (attempts) {
        await sleep(200);

        continue;
      }

      throw e;
    }
  }
}

/**
 * @param {ethers.Wallet} wallet
 * @param {bigint} amount
 */
async function approveWeth(wallet, amount) {
  amount = BigInt(amount);

  const wethContract = getWethContract(wallet);
  const allowance = await wethContract.allowance.staticCall(wallet.address, SALE_CONTRACT_ADDRESS);

  if (allowance >= amount) return;

  console.log(chalk.blue(`[${wallet.address}] Приступаю к апруву wETH...`));
  console.log();

  const transaction = await wethContract.approve(SALE_CONTRACT_ADDRESS, amount);
  await transaction.wait(1, 300_000);

  console.log(chalk.green(`[${wallet.address}] wETH апрувнуты`));
  console.log();
}

async function getPurchaseSignature(address, tierId) {
  const data = await gotScraping({
    url: 'https://backend.impossible.finance/api/backend-service/allocation/icn',
    method: 'POST',
    searchParams: {
      address,
      tierId,
    },
    json: {
      address,
      tierId,
      saleAddress: SALE_CONTRACT_ADDRESS,
    },
    responseType: 'json',
    resolveBodyOnly: true,
  });

  if (data.status_code === 200 && data.data) {
    return data.data;
  }

  throw new Error(`Ошибка получения подписи для покупки: ${JSON.stringify(data)}`);
}

function getSaleContract(runner) {
  return new ethers.Contract(SALE_CONTRACT_ADDRESS, SALE_CONTRACT_ABI, runner);
}

function getWethContract(runner) {
  return new ethers.Contract(WETH_CONTRACT_ADDRESS, WETH_CONTRACT_ABI, runner);
}

function printTimeLeft() {
  let timeLeft = SALE_START_TIME - Date.now();

  if (timeLeft <= 0) return;

  const h = Math.trunc(timeLeft / 3600000);
  timeLeft -= h * 3600000;
  const m = Math.trunc(timeLeft / 60000);
  timeLeft -= m * 60000;
  const s = Math.trunc(timeLeft / 1000);

  const countdown = [h, m, s].map((num) => num.toString().padStart(2, '0')).join(':');

  console.log(chalk.yellow(`До начала сейла осталось ${countdown}`));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
