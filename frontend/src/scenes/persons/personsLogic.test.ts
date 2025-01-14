import { mockAPI } from 'lib/api.mock'
import { expectLogic } from 'kea-test-utils'
import { initKeaTests } from '~/test/init'
import { personsLogic } from './personsLogic'
import { router } from 'kea-router'
import { PropertyOperator } from '~/types'

jest.mock('lib/api')

describe('personsLogic', () => {
    let logic: ReturnType<typeof personsLogic.build>

    mockAPI(async ({ pathname, searchParams }) => {
        if (
            `api/person/` === pathname &&
            (JSON.stringify(searchParams) == '{}' ||
                JSON.stringify(searchParams) == JSON.stringify({ properties: [{ key: 'email', operator: 'is_set' }] }))
        ) {
            return { result: ['result from api'] }
        } else if (`api/person/` === pathname && ['abc', 'xyz'].includes(searchParams['distinct_id'])) {
            return { results: ['person from api'] }
        } else if (`api/person/` === pathname && ['test@test.com'].includes(searchParams['distinct_id'])) {
            return {
                results: [
                    {
                        id: 1,
                        name: 'test@test.com',
                        distinct_ids: ['test@test.com'],
                        uuid: 'abc-123',
                    },
                ],
            }
        }
    })

    beforeEach(() => {
        initKeaTests()
        logic = personsLogic({ syncWithUrl: true })
        logic.mount()
    })

    describe('syncs with insightLogic', () => {
        it('setAllFilters properties works', async () => {
            router.actions.push('/persons')
            await expectLogic(logic, () => {
                logic.actions.setListFilters({
                    properties: [{ key: 'email', operator: PropertyOperator.IsSet }],
                })
                logic.actions.loadPersons()
            })
                .toMatchValues(logic, {
                    listFilters: { properties: [{ key: 'email', operator: 'is_set' }] },
                })
                .toDispatchActions(router, ['replace', 'locationChanged'])
                .toMatchValues(router, { searchParams: { properties: [{ key: 'email', operator: 'is_set' }] } })
        })
        it('properties from url works', async () => {
            router.actions.push('/persons', { properties: [{ key: 'email', operator: 'is_set' }] })
            await expectLogic(logic, () => {}).toMatchValues(logic, {
                listFilters: { properties: [{ key: 'email', operator: 'is_set' }] },
            })

            // Expect a clean url (no ?properties={})
            await expectLogic(logic, () => {
                logic.actions.setListFilters({
                    properties: [],
                })
                logic.actions.loadPersons()
            })
                .toDispatchActions(router, ['replace', 'locationChanged'])
                .toMatchValues(router, { searchParams: {} })
        })
    })

    describe('loads a person', () => {
        it('starts with a null person', async () => {
            await expectLogic(logic).toMatchValues({
                person: null,
            })
        })

        it('gets the person from the url', async () => {
            router.actions.push('/person/test%40test.com')

            await expectLogic(logic)
                .toDispatchActions(['loadPerson', 'loadPersonSuccess'])
                .toMatchValues({
                    person: {
                        id: 1,
                        name: 'test@test.com',
                        distinct_ids: ['test@test.com'],
                        uuid: 'abc-123',
                    },
                })

            // Dont fetch again if the url changes (even with encoded distinct IDs)
            router.actions.push('/person/test%40test.com', {}, { sessionRecordingId: 'abc-123' })
            await expectLogic(logic).toNotHaveDispatchedActions(['loadPerson'])
        })

        it('loads a person', async () => {
            await expectLogic(logic, () => {
                logic.actions.loadPerson('abc')
            })
                .toDispatchActions(['loadPerson', 'loadPersonSuccess'])
                .toMatchValues({
                    person: 'person from api',
                })
        })

        it('clears the person when switching between people', async () => {
            await expectLogic(logic, () => {
                logic.actions.loadPerson('abc')
            })
                .toDispatchActions(['loadPersonSuccess'])
                .toMatchValues({
                    person: 'person from api',
                })

            await expectLogic(logic, () => {
                logic.actions.loadPerson('xyz')
            })
                .toMatchValues({
                    person: null,
                })
                .toDispatchActions(['loadPersonSuccess'])
                .toMatchValues({
                    person: 'person from api',
                })
        })
    })

    describe('Load cohorts', () => {
        it("Doesn't load cohort if we're on ", async () => {
            await expectLogic(logic, () => {
                logic.actions.loadCohorts()
            }).toMatchValues({ cohorts: null })
        })
    })
})
