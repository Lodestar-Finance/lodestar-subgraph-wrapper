import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express'
import expressWs from 'express-ws'
import bodyParser from 'body-parser'
import winston from 'winston'
import expressWinston from 'express-winston'
import http from 'http'
import WebSocket from 'ws'
import BigNumber from 'bignumber.js'
import { SubscriptionClient } from 'subscriptions-transport-ws'
import { ApolloServer } from 'apollo-server-express'
import { split } from 'apollo-link'
import { HttpLink } from 'apollo-link-http'
import { WebSocketLink } from 'apollo-link-ws'
import { fetch } from 'apollo-env'
import { getMainDefinition } from 'apollo-utilities'
import { GraphQLSchema } from 'graphql'
import {
  introspectSchema,
  makeExecutableSchema,
  makeRemoteExecutableSchema,
  mergeSchemas,
} from 'graphql-tools'
import bigDecimal = require('bigdecimal');

/**
 * Logging
 */

let loggerColorizer = winston.format.colorize()
let loggerTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.timestamp(),
    loggerColorizer,
    winston.format.ms(),
    winston.format.printf(args => {
      let { level, message, component, timestamp, ms } = args
      return `${timestamp} ${level} ${component} → ${message} ${loggerColorizer.colorize(
        'debug',
        ms,
      )}`
    }),
  ),
})
let logger = winston
  .createLogger({
    level: 'debug',
    transports: [loggerTransport],
  })
  .child({ component: 'App' })

/**
 * GraphQL context
 */

interface GraphQLContext {
  logger: winston.Logger
}

/**
 * GraphQL schema
 */

const SUBGRAPH_QUERY_ENDPOINT = process.env.SUBGRAPH_QUERY_ENDPOINT
const SUBGRAPH_SUBSCRIPTION_ENDPOINT = process.env.SUBGRAPH_SUBSCRIPTION_ENDPOINT

if (!SUBGRAPH_QUERY_ENDPOINT) {
  throw new Error('Environment variable SUBGRAPH_QUERY_ENDPOINT is not set')
}

if (!SUBGRAPH_SUBSCRIPTION_ENDPOINT) {
  throw new Error('Environment variable SUBGRAPH_SUBSCRIPTION_ENDPOINT is not set')
}

const createQueryNodeHttpLink = () =>
  new HttpLink({
    uri: SUBGRAPH_QUERY_ENDPOINT,
    fetch: fetch as any,
  })

const createSchema = async (): Promise<GraphQLSchema> => {
  let httpLink = createQueryNodeHttpLink()
  let remoteSchema = await introspectSchema(httpLink)

  const subscriptionClient = new SubscriptionClient(
    SUBGRAPH_SUBSCRIPTION_ENDPOINT,
    {
      reconnect: true,
    },
    WebSocket,
  )

  const wsLink = new WebSocketLink(subscriptionClient)
  const link = split(
    ({ query }) => {
      const { kind, operation } = getMainDefinition(query) as any
      return kind === 'OperationDefinition' && operation === 'subscription'
    },
    wsLink,
    httpLink,
  )

  let subgraphSchema = makeRemoteExecutableSchema({
    schema: remoteSchema,
    link,
  })

  let customSchema = `
    extend type Account {
      totalBorrowValueInEth: BigDecimal!
      totalCollateralValueInEth: BigDecimal!
    }

    extend type AccountCToken {
      supplyBalanceUnderlying: BigDecimal!
      lifetimeSupplyInterestAccrued: BigDecimal!
      borrowBalanceUnderlying: BigDecimal!
      lifetimeBorrowInterestAccrued: BigDecimal!
      supplyBalanceETH: BigDecimal!
    }
  `

  const bignum = (value: string) => new BigNumber(value)

  const bigdec = (value: string) => new bigDecimal(value)

  const supplyBalanceUnderlying = (cToken: any): bigDecimal =>
    bigdec(cToken.cTokenBalance).multiply(cToken.market.exchangeRate)

  const borrowBalanceUnderlying = (cToken: any): bigDecimal => {
    if (bigdec(cToken.accountBorrowIndex)==(bigdec('0'))) {
      return bigdec('0')
    } else {
      return bigdec(cToken.storedBorrowBalance)
          .multiply(cToken.market.borrowIndex)
          .divide(cToken.accountBorrowIndex, 18)
    }
  }

  const tokenInEth = (market: any): bigDecimal =>
    bigdec(market.collateralFactor)
      .multiply(market.exchangeRate)
      .multiply(market.underlyingPrice)

  const supplyBalanceETH = (cToken: any) : bigDecimal => 
    supplyBalanceUnderlying(cToken).multiply(cToken.market.underlyingPrice)

  const borrowBalanceETH = (cToken: any) : bigDecimal => 
    borrowBalanceUnderlying(cToken).multiply(cToken.market.underlyingPrice)

  const totalCollateralValueInEth = (account: any): bigDecimal =>
    account.___tokens.reduce(
      (acc, token) => acc.plus(tokenInEth(token.market).multiply(token.cTokenBalance)),
      bigdec('0'),
    )

  const totalBorrowValueInEth = (account: any): bigDecimal =>
    !account.hasBorrowed
      ? bigdec('0')
      : account.___tokens.reduce(
          (acc, token) =>
            acc.plus(
              bigdec(token.market.underlyingPrice).multiply(borrowBalanceUnderlying(token)),
            ),
          bigdec('0'),
        )

  return mergeSchemas({
    schemas: [subgraphSchema, customSchema],
    resolvers: {
      Account: {
        health: {
          fragment: `
            ... on Account {
              id
              hasBorrowed
              ___tokens: tokens {
                cTokenBalance
                storedBorrowBalance
                accountBorrowIndex
                market {
                  borrowIndex
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
          resolve: (account, _args, _context, _info) => {
            if (!account.hasBorrowed) {
              return null
            } else {
              let totalBorrow = totalBorrowValueInEth(account)
              if(totalBorrow == bigdec('0')) {
                return totalCollateralValueInEth(account)
              } else {
                return totalCollateralValueInEth(account).divide(totalBorrow, 18)
              }
            }
          },
        },

        totalBorrowValueInEth: {
          fragment: `
            ... on Account {
              id
              hasBorrowed
              ___tokens: tokens {
                cTokenBalance
                storedBorrowBalance
                accountBorrowIndex
                market {
                  borrowIndex
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
          resolve: (account, _args, _context, _info) => totalBorrowValueInEth(account),
        },

        totalCollateralValueInEth: {
          fragment: `
            ... on Account {
              id
              ___tokens: tokens {
                cTokenBalance
                market {
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
          resolve: (account, _args, _context, _info) =>
            totalCollateralValueInEth(account),
        },
      },

      AccountCToken: {
        supplyBalanceUnderlying: {
          fragment: `... on AccountCToken { id cTokenBalance market { exchangeRate } }`,
          resolve: (cToken, _args, _context, _info) => supplyBalanceUnderlying(cToken),
        },

        supplyBalanceETH: {
          fragment: `
            ... on AccountCToken {
              id
              supplyBalanceUnderlying
              market {
                underlyingPrice
              }
            }
          `,
          resolve: (cToken, _args, _context, _info) => supplyBalanceETH(cToken),
        },

        lifetimeSupplyInterestAccrued: {
          fragment: `
            ... on AccountCToken {
              id
              cTokenBalance
              market { exchangeRate }
              totalUnderlyingSupplied
              totalUnderlyingRedeemed
            }
          `,
          resolve: (cToken, _args, _context, _info) =>
            supplyBalanceUnderlying(cToken)
              .subtract(cToken.totalUnderlyingSupplied)
              .add(cToken.totalUnderlyingRedeemed),
        },

        borrowBalanceUnderlying: {
          fragment: `
            ... on AccountCToken {
              id
              storedBorrowBalance
              accountBorrowIndex
              market { borrowIndex }
            }
          `,
          resolve: (cToken, _args, _context, _info) => borrowBalanceUnderlying(cToken),
        },

        borrowBalanceETH: {
          fragment: `
            ... on AccountCToken {
              id
              borrowBalanceUnderlying
              market {
                underlyingPrice
              }
            }
          `,
          resolve: (cToken, _args, _context, _info) => borrowBalanceETH(cToken),
        },

        lifetimeBorrowInterestAccrued: {
          fragment: `
            ... on AccountCToken {
              id
              storedBorrowBalance
              accountBorrowIndex
              market { borrowIndex }
              totalUnderlyingBorrowed
              totalUnderlyingRepaid
            }
          `,
          resolve: (cToken, _args, _context, _info) =>
            borrowBalanceUnderlying(cToken)
              .subtract(cToken.totalUnderlyingBorrowed)
              .add(cToken.totalUnderlyingRepaid),
        },
      },
    },
  })
}

/**
 * Server application
 */

// Define the middleware
const rejectBadHeaders = async (req: Request, res: Response, next: NextFunction) => {
  if (
    req.headers['challenge-bypass-token'] ||
    req.headers['x_proxy_id']
    // Note: This one doesn't work on Google Cloud:
    // req.headers["via"]
  ) {
    return res.status(400).send('Bad Request')
  } else {
    next()
  }
}

const run = async () => {
  logger.info(`Create application`)
  const { app } = expressWs(express())
  app.use(rejectBadHeaders)
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(
    expressWinston.logger({
      level: 'debug',
      transports: [loggerTransport],
      baseMeta: { component: 'Server' },
    }),
  )
  app.use(
    expressWinston.errorLogger({
      transports: [loggerTransport],
      baseMeta: { component: 'Server' },
    }),
  )

  logger.info(`Create Apollo server`)
  const apolloServer = new ApolloServer({
    subscriptions: {
      path: '/',
    },
    schema: await createSchema(),
    introspection: true,
    playground: true,
    context: async ({ req }: any): Promise<GraphQLContext> => {
      return {
        logger: logger.child({ component: 'ApolloServer' }),
      }
    },
  })

  logger.info(`Install GraphQL request handlers`)
  apolloServer.applyMiddleware({
    app,
    path: '/',
    cors: {
      origin: '*',
    },
  })

  logger.info(`Create HTTP server`)
  const server = http.createServer(app)

  logger.info(`Install GraphQL subscription handlers`)
  apolloServer.installSubscriptionHandlers(server)

  logger.info(`Start server`)
  try {
    await server.listen(9500, () => {
      logger.info('Listening on port 9500')
    })
  } catch (e) {
    logger.error(`Server crashed:`, e)
    process.exitCode = 1
  }
}

run()
