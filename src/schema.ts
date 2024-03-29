import {
  GraphQLSchema,
  GraphQLString,
  GraphQLFloat,
  GraphQLList,
  GraphQLObjectType,
  printSchema,
  isInputType,
  GraphQLScalarType,
  GraphQLObjectTypeConfig,
  GraphQLBoolean,
} from 'graphql'
import { ResolverGenerator } from './resolvers'
import { Config, KSqlDBEntities, ResolverFields } from './type/definition'
import { Missing, KsqlDBMutation } from './graphQLObjectTypes'
import { Field } from 'ksqldb-rx-client/dist/types/api/ksql/field'
import { SourceDescription } from 'ksqldb-rx-client/dist/types/api/ksql/source-description'

const TypeMap = {
  STRING: GraphQLString,
  VARCHAR: GraphQLString,
  BIGINT: GraphQLFloat, // the BIGINT that is given back is larger than graphql supports, so it has to be a float
  DOUBLE: GraphQLFloat,
  INTEGER: GraphQLFloat,
  BOOLEAN: GraphQLBoolean,
  ARRAY: {
    STRING: new GraphQLList(GraphQLString),
    VARCHAR: new GraphQLList(GraphQLString),
    BIGINT: new GraphQLList(GraphQLFloat),
    DOUBLE: new GraphQLList(GraphQLFloat),
    INTEGER: new GraphQLList(GraphQLFloat),
    BOOLEAN: new GraphQLList(GraphQLBoolean),
  },
  STRUCT: {}, // MemberSchema exclude not excluding this?
} as any

const setSchemaType = (accum: KSqlDBEntities, field: Field): void => {
  if (TypeMap[field.schema.type] == null) {
    // eslint-disable-next-line
    console.error(`type ${field.schema.type} is not supported`)
    return
  }

  if (field.schema.memberSchema?.type != null) {
    const sclarType: GraphQLScalarType = TypeMap[field.schema.type][
      field.schema.memberSchema.type
    ] as GraphQLScalarType
    accum[field.name] = {
      type: sclarType,
    }
  } else {
    const sclarType: GraphQLScalarType = TypeMap[field.schema.type] as GraphQLScalarType
    accum[field.name] = {
      type: sclarType,
    }
  }
}

const buildSchemaObject = (accum: KSqlDBEntities, field: Field): KSqlDBEntities => {
  if (field.schema.fields == null) {
    setSchemaType(accum, field)
  } else if (Array.isArray(field.schema.fields)) {
    const fields = field.schema.fields.reduce(buildSchemaObject, {})
    if (accum[field.name] == null) {
      accum[field.name] = { type: new GraphQLObjectType({ name: field.name, fields: fields }) }
    } else {
      // eslint-disable-next-line
      console.warn(`${field.name} already exists.`)
    }
  }
  return accum
}

export const generateSchemaFromKsql = ({
  name,
  fields,
}: SourceDescription): GraphQLObjectTypeConfig<void, void> => {
  const schemaFields = fields.reduce(buildSchemaObject, {})
  return {
    name,
    fields: schemaFields,
  }
}

// TODO support nested objects for resolving
const generateGraqphQLArgs = (fields: any): any =>
  Object.keys(fields).reduce((accum: any, filter: any) => {
    if (isInputType(fields[filter].type)) {
      accum[filter] = fields[filter]
    }
    return accum
  }, {})

function generateQueries(streams: Array<SourceDescription>, subscriptionFields: any) {
  return (accum: { [name: string]: any }, query: any): any => {
    const schemaType = new GraphQLObjectType(query)
    const ksqlDBQuery = streams.find((stream) => stream.name === query.name)
    // if a ksqlDB query is writing something, it's materialized, so it qualifies as a query
    if (ksqlDBQuery != null && ksqlDBQuery.writeQueries.length > 0) {
      const args = generateGraqphQLArgs(query.fields)
      if (subscriptionFields[query.name] != null) {
        accum[query.name] = subscriptionFields[query.name]
      } else {
        accum[query.name] = {
          type: schemaType,
          args,
        }
      }
    }
    return accum
  }
}

// anything can be a subscription
function generateSubscription(accum: { [name: string]: any }, query: any): any {
  const schemaType = new GraphQLObjectType(query)
  const args = generateGraqphQLArgs(query.fields)
  accum[query.name] = {
    type: schemaType,
    args,
  }
  return accum
}

function generateMutations(accum: { [name: string]: any }, query: any): any {
  const args = generateGraqphQLArgs(query.fields)
  accum[query.name] = {
    type: KsqlDBMutation,
    args,
  }
  return accum
}
export const generateSchemaAndFields = (
  streams: Array<SourceDescription>
): {
  schema: GraphQLSchema
  fields: ResolverFields
} => {
  const schemas: GraphQLObjectTypeConfig<void, void>[] = []
  for (const stream of streams) {
    schemas.push(generateSchemaFromKsql(stream))
  }

  const subscriptionFields = schemas.reduce(generateSubscription, {})
  const mutationFields = schemas.reduce(generateMutations, {})

  let queryFields = schemas.reduce(generateQueries(streams, subscriptionFields), {})
  // if you have no materialized views, graphql won't work, so default to subscriptions, already logged out this won't work
  // why default? http://spec.graphql.org/June2018/#sec-Schema
  if (Object.keys(queryFields).length === 0) {
    // eslint-disable-next-line
    console.error(
      'No materalized views have been registered.',
      'Only subscriptions and mutations will be work properly.',
      'Defaulting `type Query` to null scalar since it is required by graphQL.'
    )
    queryFields = { KsqlDBGraphQLError: Missing }
  }

  return {
    schema: new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: queryFields,
      }),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: subscriptionFields,
      }),

      mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutationFields }),
    }),
    fields: {
      queryFields: Object.keys(queryFields)
        .filter((key) => {
          return queryFields[key] !== Missing
        })
        .reduce((accum: any, key: string) => {
          accum[key] = queryFields[key]
          return accum
        }, {}),
      subscriptionFields,
      mutationFields,
    },
  }
}

const schemas = async ({
  ksqlDBClient,
  streamsFilter = () => true,
  tablesFilter = () => true,
}: Config): Promise<{ schema: GraphQLSchema; fields: ResolverFields } | undefined> => {
  try {
    const streamsResp = await ksqlDBClient.listStreamsExtended()
    const tablesResp = await ksqlDBClient.listTablesExtended()
    let sources = streamsResp.sourceDescriptions?.filter(streamsFilter) || []
    sources = sources.concat(tablesResp.sourceDescriptions?.filter(tablesFilter) || [])

    if (sources.length === 0) {
      throw new Error('No Stream or Table exists on the server')
    }

    return generateSchemaAndFields(sources as any)
  } catch (e: any) {
    // eslint-disable-next-line
    console.error(`Could not generate schemas:`, e.message)
  }
}

export const buildKsqlDBGraphQL = (
  options: Config
): Promise<{
  schemas: any
  queryResolvers: any
  subscriptionResolvers: any
  mutationResolvers: any
}> => {
  return new Promise((resolve) => {
    ;(async function run(): Promise<void> {
      try {
        const result = await schemas(options)
        if (result) {
          // eslint-disable-next-line
          console.log(printSchema(result.schema))
          const { queryResolvers, subscriptionResolvers, mutationResolvers } =
            new ResolverGenerator(result.fields)
          resolve({
            schemas: result.schema,
            queryResolvers,
            subscriptionResolvers,
            mutationResolvers,
          })
        } else {
          throw new Error('Unable to create schemas and resolvers')
        }
      } catch (e: any) {
        throw new Error(e)
        // noop
      }
    })()
  })
}
