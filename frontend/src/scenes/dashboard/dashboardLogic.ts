import { isBreakpoint, kea } from 'kea'
import api from 'lib/api'
import { dashboardsModel } from '~/models/dashboardsModel'
import { prompt } from 'lib/logic/prompt'
import { router } from 'kea-router'
import { clearDOMTextSelection, isUserLoggedIn, setPageTitle, toParams } from 'lib/utils'
import { insightsModel } from '~/models/insightsModel'
import {
    ACTIONS_LINE_GRAPH_LINEAR,
    PATHS_VIZ,
    DashboardPrivilegeLevel,
    OrganizationMembershipLevel,
} from 'lib/constants'
import { DashboardEventSource, eventUsageLogic } from 'lib/utils/eventUsageLogic'
import {
    Breadcrumb,
    InsightModel,
    DashboardLayoutSize,
    DashboardMode,
    DashboardType,
    FilterType,
    InsightShortId,
    InsightType,
} from '~/types'
import { dashboardLogicType } from './dashboardLogicType'
import { Layout, Layouts } from 'react-grid-layout'
import { insightLogic } from 'scenes/insights/insightLogic'
import { teamLogic } from '../teamLogic'
import { urls } from 'scenes/urls'
import { getInsightId } from 'scenes/insights/utils'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { userLogic } from 'scenes/userLogic'

export const BREAKPOINTS: Record<DashboardLayoutSize, number> = {
    sm: 1024,
    xs: 0,
}
export const BREAKPOINT_COLUMN_COUNTS: Record<DashboardLayoutSize, number> = { sm: 12, xs: 1 }
export const MIN_ITEM_WIDTH_UNITS = 3
export const MIN_ITEM_HEIGHT_UNITS = 5

const IS_TEST_MODE = process.env.NODE_ENV === 'test'

export interface DashboardLogicProps {
    id?: number
    shareToken?: string
    internal?: boolean
}

export const AUTO_REFRESH_INITIAL_INTERVAL_SECONDS = 300

export const dashboardLogic = kea<dashboardLogicType<DashboardLogicProps>>({
    path: (key) => ['scenes', 'dashboard', 'dashboardLogic', key],
    connect: {
        values: [teamLogic, ['currentTeamId'], featureFlagLogic, ['featureFlags']],
        logic: [dashboardsModel, insightsModel, eventUsageLogic],
    },

    props: {} as DashboardLogicProps,

    key: (props) => props.id || 'dashboardLogic',

    actions: {
        setReceivedErrorsFromAPI: (receivedErrors: boolean) => ({
            receivedErrors,
        }),
        addNewDashboard: true,
        loadDashboardItems: ({
            refresh,
            dive_source_id,
        }: {
            refresh?: boolean
            dive_source_id?: InsightShortId
        } = {}) => ({
            refresh,
            dive_source_id,
        }),
        triggerDashboardUpdate: (payload) => ({ payload }),
        /** Whether the dashboard is shared or not. */
        setIsSharedDashboard: (id: number, isShared: boolean) => ({ id, isShared }),
        /** The current state in which the dashboard is being viewed, see DashboardMode. */
        setDashboardMode: (mode: DashboardMode | null, source: DashboardEventSource | null) => ({ mode, source }),
        updateLayouts: (layouts: Layouts) => ({ layouts }),
        updateContainerWidth: (containerWidth: number, columns: number) => ({ containerWidth, columns }),
        saveLayouts: true,
        updateItemColor: (insightId: number, color: string | null) => ({ insightId, color }),
        removeItem: (insightId: number) => ({ insightId }),
        refreshAllDashboardItems: (items?: InsightModel[]) => ({ items }),
        refreshAllDashboardItemsManual: true,
        resetInterval: true,
        updateAndRefreshDashboard: true,
        setDates: (dateFrom: string, dateTo: string | null, reloadDashboard = true) => ({
            dateFrom,
            dateTo,
            reloadDashboard,
        }),
        /** Take the user to insights to add a graph. */
        addGraph: true,
        setAutoRefresh: (enabled: boolean, interval: number) => ({ enabled, interval }),
        setRefreshStatus: (shortId: InsightShortId, loading = false) => ({ shortId, loading }),
        setRefreshStatuses: (shortIds: InsightShortId[], loading = false) => ({ shortIds, loading }),
        setRefreshError: (shortId: InsightShortId) => ({ shortId }),
        reportDashboardViewed: true, // Reports `viewed dashboard` and `dashboard analyzed` events
        setShouldReportOnAPILoad: (shouldReport: boolean) => ({ shouldReport }), // See reducer for details
    },

    loaders: ({ actions, props }) => ({
        allItems: [
            null as DashboardType | null,
            {
                loadDashboardItems: async ({ refresh, dive_source_id }) => {
                    actions.setReceivedErrorsFromAPI(false)

                    if (!props.id) {
                        console.warn('Called `loadDashboardItems` but ID is not set.')
                        return
                    }

                    try {
                        const apiUrl = props.shareToken
                            ? `api/shared_dashboards/${props.shareToken}`
                            : `api/projects/${teamLogic.values.currentTeamId}/dashboards/${props.id}/?${toParams({
                                  refresh,
                                  dive_source_id: dive_source_id ? await getInsightId(dive_source_id) : undefined,
                              })}`
                        const dashboard = await api.get(apiUrl)
                        actions.setDates(dashboard.filters.date_from, dashboard.filters.date_to, false)
                        setPageTitle(dashboard.name ? `${dashboard.name} • Dashboard` : 'Dashboard')
                        return dashboard
                    } catch (error) {
                        if (error.status === 404) {
                            return []
                        }
                        actions.setReceivedErrorsFromAPI(true)
                        throw error
                    }
                },
            },
        ],
    }),
    reducers: ({ props }) => ({
        receivedErrorsFromAPI: [
            false,
            {
                setReceivedErrorsFromAPI: (_: boolean, { receivedErrors }: { receivedErrors: boolean }) =>
                    receivedErrors,
            },
        ],
        filters: [
            { date_from: null, date_to: null } as FilterType,
            {
                setDates: (state, { dateFrom, dateTo }) => ({
                    ...state,
                    date_from: dateFrom || null,
                    date_to: dateTo || null,
                }),
            },
        ],
        allItems: [
            null as DashboardType | null,
            {
                [insightsModel.actionTypes.renameInsightSuccess]: (state, { item }) => {
                    return {
                        ...state,
                        items: state?.items.map((i) => (i.short_id === item.short_id ? item : i)) || [],
                    } as DashboardType
                },
                updateLayouts: (state, { layouts }) => {
                    const itemLayouts: Record<string, Partial<Record<string, Layout>>> = {}
                    state?.items.forEach((item) => {
                        itemLayouts[item.short_id] = {}
                    })

                    Object.entries(layouts).forEach(([col, layout]) => {
                        layout.forEach((layoutItem) => {
                            if (!itemLayouts[layoutItem.i]) {
                                itemLayouts[layoutItem.i] = {}
                            }
                            itemLayouts[layoutItem.i][col] = layoutItem
                        })
                    })

                    return {
                        ...state,
                        items: state?.items.map((item) => ({ ...item, layouts: itemLayouts[item.short_id] })),
                    } as DashboardType
                },
                [dashboardsModel.actionTypes.updateDashboardItem]: (state, { item }) => {
                    return state
                        ? ({
                              ...state,
                              items: state?.items.map((i) => (i.short_id === item.short_id ? item : i)) || [],
                          } as DashboardType)
                        : null
                },
                [dashboardsModel.actionTypes.updateDashboardSuccess]: (state, { dashboard }) => {
                    return state && dashboard && state.id === dashboard.id ? dashboard : state
                },
                [dashboardsModel.actionTypes.updateDashboardRefreshStatus]: (
                    state,
                    { shortId, refreshing, last_refresh }
                ) => {
                    // If not a dashboard item, don't do anything.
                    if (!shortId) {
                        return state
                    }
                    return {
                        ...state,
                        items: state?.items.map((i) =>
                            i.short_id === shortId
                                ? {
                                      ...i,
                                      ...(refreshing != null ? { refreshing } : {}),
                                      ...(last_refresh != null ? { last_refresh } : {}),
                                  }
                                : i
                        ),
                    } as DashboardType
                },
                updateItemColor: (state, { insightId, color }) => {
                    return {
                        ...state,
                        items: state?.items.map((i) => (i.id === insightId ? { ...i, color } : i)),
                    } as DashboardType
                },
                removeItem: (state, { insightId }) => {
                    return {
                        ...state,
                        items: state?.items.filter((i) => i.id !== insightId),
                    } as DashboardType
                },
                [insightsModel.actionTypes.duplicateInsightSuccess]: (state, { item }): DashboardType => {
                    return {
                        ...state,
                        items:
                            props.id && item.dashboard === parseInt(props.id.toString())
                                ? [...(state?.items || []), item]
                                : state?.items,
                    } as DashboardType
                },
            },
        ],
        refreshStatus: [
            {} as Record<
                string,
                {
                    loading?: boolean
                    refreshed?: boolean
                    error?: boolean
                }
            >,
            {
                setRefreshStatus: (state, { shortId, loading }) => ({
                    ...state,
                    [shortId]: loading ? { loading: true } : { refreshed: true },
                }),
                setRefreshStatuses: (_, { shortIds, loading }) =>
                    Object.fromEntries(
                        shortIds.map((shortId) => [shortId, loading ? { loading: true } : { refreshed: true }])
                    ) as Record<
                        string,
                        {
                            loading?: boolean
                            refreshed?: boolean
                            error?: boolean
                        }
                    >,
                setRefreshError: (state, { shortId }) => ({
                    ...state,
                    [shortId]: { error: true },
                }),
                refreshAllDashboardItems: () => ({}),
            },
        ],
        columns: [
            null as number | null,
            {
                updateContainerWidth: (_, { columns }) => columns,
            },
        ],
        containerWidth: [
            null as number | null,
            {
                updateContainerWidth: (_, { containerWidth }) => containerWidth,
            },
        ],
        dashboardMode: [
            null as DashboardMode | null,
            {
                setDashboardMode: (_, { mode }) => mode,
            },
        ],
        lastDashboardModeSource: [
            null as DashboardEventSource | null,
            {
                setDashboardMode: (_, { source }) => source,
            },
        ],
        autoRefresh: [
            {
                interval: AUTO_REFRESH_INITIAL_INTERVAL_SECONDS,
                enabled: false,
            } as {
                interval: number
                enabled: boolean
            },
            { persist: true },
            {
                setAutoRefresh: (_, { enabled, interval }) => ({ enabled, interval }),
            },
        ],
        shouldReportOnAPILoad: [
            /* Whether to report viewed/analyzed events after the API is loaded (and this logic is mounted).
            We need this because the DashboardView component might be mounted (and subsequent `useEffect`) before the API request
            to `loadDashboardItems` is completed (e.g. if you open PH directly to a dashboard) 
            */
            false,
            {
                setShouldReportOnAPILoad: (_, { shouldReport }) => shouldReport,
            },
        ],
    }),
    selectors: ({ props, selectors }) => ({
        items: [() => [selectors.allItems], (allItems) => allItems?.items?.filter((i) => !i.deleted)],
        itemsLoading: [
            () => [selectors.allItemsLoading, selectors.refreshStatus],
            (allItemsLoading, refreshStatus) => {
                return allItemsLoading || Object.values(refreshStatus).some((s) => s.loading)
            },
        ],
        isRefreshing: [
            () => [selectors.refreshStatus],
            (refreshStatus) => (id: string) => !!refreshStatus[id]?.loading,
        ],
        highlightedInsightId: [
            () => [router.selectors.searchParams],
            (searchParams) => searchParams.highlightInsightId || searchParams.dive_source_id,
        ],
        lastRefreshed: [
            () => [selectors.items],
            (items) => {
                if (!items || !items.length) {
                    return null
                }
                let lastRefreshed = items[0].last_refresh

                for (const item of items) {
                    if (item.last_refresh && (!lastRefreshed || item.last_refresh < lastRefreshed)) {
                        lastRefreshed = item.last_refresh
                    }
                }

                return lastRefreshed
            },
        ],
        dashboard: [
            () => [dashboardsModel.selectors.sharedDashboard, dashboardsModel.selectors.nameSortedDashboards],
            (sharedDashboard, dashboards): DashboardType | null => {
                return props.shareToken ? sharedDashboard : dashboards.find((d) => d.id === props.id) || null
            },
        ],
        canEditDashboard: [
            (s) => [s.dashboard],
            (dashboard) => !!dashboard && dashboard.effective_privilege_level >= DashboardPrivilegeLevel.CanEdit,
        ],
        canRestrictDashboard: [
            // Sync conditions with backend can_user_restrict
            (s) => [s.dashboard, userLogic.selectors.user, teamLogic.selectors.currentTeam],
            (dashboard, user, currentTeam): boolean =>
                !!dashboard &&
                !!user &&
                (user.uuid === dashboard.created_by?.uuid ||
                    (!!currentTeam?.effective_membership_level &&
                        currentTeam.effective_membership_level >= OrganizationMembershipLevel.Admin)),
        ],
        sizeKey: [
            (s) => [s.columns],
            (columns): DashboardLayoutSize | undefined => {
                const [size] = (Object.entries(BREAKPOINT_COLUMN_COUNTS).find(([, value]) => value === columns) ||
                    []) as [DashboardLayoutSize, number]
                return size
            },
        ],
        layouts: [
            (s) => [s.items],
            (items) => {
                // The dashboard redesign includes constraints on the size of dashboard items
                const minW = MIN_ITEM_WIDTH_UNITS
                const minH = MIN_ITEM_HEIGHT_UNITS

                const allLayouts: Partial<Record<keyof typeof BREAKPOINT_COLUMN_COUNTS, Layout[]>> = {}

                for (const col of Object.keys(BREAKPOINT_COLUMN_COUNTS) as (keyof typeof BREAKPOINT_COLUMN_COUNTS)[]) {
                    const layouts = items
                        ?.filter((i) => !i.deleted)
                        .map((item) => {
                            const isRetention =
                                item.filters.insight === InsightType.RETENTION &&
                                item.filters.display === ACTIONS_LINE_GRAPH_LINEAR
                            const defaultWidth = isRetention || item.filters.display === PATHS_VIZ ? 8 : 6
                            const defaultHeight = isRetention ? 8 : item.filters.display === PATHS_VIZ ? 12.5 : 5
                            const layout = item.layouts && item.layouts[col]
                            const { x, y, w, h } = layout || {}
                            const width = Math.min(w || defaultWidth, BREAKPOINT_COLUMN_COUNTS[col])
                            return {
                                i: item.short_id,
                                x: Number.isInteger(x) && x + width - 1 < BREAKPOINT_COLUMN_COUNTS[col] ? x : 0,
                                y: Number.isInteger(y) ? y : Infinity,
                                w: width,
                                h: h || defaultHeight,
                                minW,
                                minH,
                            }
                        })

                    const cleanLayouts = layouts?.filter(({ y }) => y !== Infinity)

                    // array of -1 for each column
                    const lowestPoints = Array.from(Array(BREAKPOINT_COLUMN_COUNTS[col])).map(() => -1)

                    // set the lowest point for each column
                    cleanLayouts?.forEach(({ x, y, w, h }) => {
                        for (let i = x; i <= x + w - 1; i++) {
                            lowestPoints[i] = Math.max(lowestPoints[i], y + h - 1)
                        }
                    })

                    layouts
                        ?.filter(({ y }) => y === Infinity)
                        .forEach(({ i, w, h }) => {
                            // how low are things in "w" consecutive of columns
                            const segmentCount = BREAKPOINT_COLUMN_COUNTS[col] - w + 1
                            const lowestSegments = Array.from(Array(segmentCount)).map(() => -1)
                            for (let k = 0; k < segmentCount; k++) {
                                for (let j = k; j <= k + w - 1; j++) {
                                    lowestSegments[k] = Math.max(lowestSegments[k], lowestPoints[j])
                                }
                            }

                            let lowestIndex = 0
                            let lowestDepth = lowestSegments[0]

                            lowestSegments.forEach((depth, index) => {
                                if (depth < lowestDepth) {
                                    lowestIndex = index
                                    lowestDepth = depth
                                }
                            })

                            cleanLayouts?.push({
                                i,
                                x: lowestIndex,
                                y: lowestDepth + 1,
                                w,
                                h,
                                minW,
                                minH,
                            })

                            for (let k = lowestIndex; k <= lowestIndex + w - 1; k++) {
                                lowestPoints[k] = Math.max(lowestPoints[k], lowestDepth + h)
                            }
                        })

                    allLayouts[col] = cleanLayouts
                }
                return allLayouts
            },
        ],
        layout: [(s) => [s.layouts, s.sizeKey], (layouts, sizeKey) => (sizeKey ? layouts[sizeKey] : undefined)],
        layoutForItem: [
            (s) => [s.layout],
            (layout) => {
                const layoutForItem: Record<string, Layout> = {}
                if (layout) {
                    for (const obj of layout) {
                        layoutForItem[obj.i] = obj
                    }
                }
                return layoutForItem
            },
        ],
        refreshMetrics: [
            (s) => [s.refreshStatus],
            (refreshStatus) => {
                const total = Object.keys(refreshStatus).length ?? 0
                return {
                    completed: total - (Object.values(refreshStatus).filter((s) => s.loading).length ?? 0),
                    total,
                }
            },
        ],
        breadcrumbs: [
            (s) => [s.allItems],
            (allItems): Breadcrumb[] => [
                {
                    name: 'Dashboards',
                    path: urls.dashboards(),
                },
                {
                    name: allItems?.id ? allItems.name || 'Unnamed' : null,
                },
            ],
        ],
    }),
    events: ({ actions, cache, props }) => ({
        afterMount: () => {
            if (props.id) {
                // When the scene is initially loaded, the dashboard ID is undefined
                actions.loadDashboardItems({
                    refresh: props.internal,
                    dive_source_id: dashboardsModel.values.diveSourceId ?? undefined,
                })
            }

            if (props.shareToken) {
                actions.setDashboardMode(
                    props.internal ? DashboardMode.Internal : DashboardMode.Public,
                    DashboardEventSource.Browser
                )
                dashboardsModel.actions.loadSharedDashboard(props.shareToken)
            }
        },
        beforeUnmount: () => {
            if (cache.autoRefreshInterval) {
                window.clearInterval(cache.autoRefreshInterval)
                cache.autoRefreshInterval = null
            }
        },
    }),
    listeners: ({ actions, values, key, cache, props }) => ({
        addNewDashboard: async () => {
            prompt({ key: `new-dashboard-${key}` }).actions.prompt({
                title: 'New dashboard',
                placeholder: 'Please enter a name',
                value: '',
                error: 'You must enter name',
                success: (name: string) => dashboardsModel.actions.addDashboard({ name }),
            })
        },
        [dashboardsModel.actionTypes.addDashboardSuccess]: ({ dashboard }) => {
            router.actions.push(`/dashboard/${dashboard.id}`)
        },
        setIsSharedDashboard: ({ id, isShared }) => {
            dashboardsModel.actions.setIsSharedDashboard({ id, isShared })
            eventUsageLogic.actions.reportDashboardShareToggled(isShared)
        },
        triggerDashboardUpdate: ({ payload }) => {
            if (values.dashboard) {
                dashboardsModel.actions.updateDashboard({ id: values.dashboard.id, ...payload })
            }
        },
        updateLayouts: () => {
            actions.saveLayouts()
        },
        saveLayouts: async (_, breakpoint) => {
            await breakpoint(300)
            if (!isUserLoggedIn()) {
                // If user is anonymous (i.e. viewing a shared dashboard logged out), we don't save any layout changes.
                return
            }
            await api.update(`api/projects/${values.currentTeamId}/insights/layouts`, {
                items:
                    values.items?.map((item) => {
                        const layouts: Record<string, Layout> = {}
                        Object.entries(item.layouts).forEach(([layoutKey, layout]) => {
                            const { i, ...rest } = layout // eslint-disable-line
                            layouts[layoutKey] = rest
                        })
                        return { id: item.id, layouts }
                    }) || [],
            })
        },
        updateItemColor: async ({ insightId, color }) => {
            return api.update(`api/projects/${values.currentTeamId}/insights/${insightId}`, { color })
        },
        removeItem: async ({ insightId }) => {
            return api.update(`api/projects/${values.currentTeamId}/insights/${insightId}`, {
                dashboard: null,
            } as Partial<InsightModel>)
        },
        refreshAllDashboardItemsManual: () => {
            // reset auto refresh interval
            actions.resetInterval()
            actions.refreshAllDashboardItems()
        },
        refreshAllDashboardItems: async ({ items: _items }, breakpoint) => {
            const items = _items || values.items || []

            // Don't do anything if there's nothing to refresh
            if (items.length === 0) {
                return
            }

            let breakpointTriggered = false
            actions.setRefreshStatuses(
                items.map((item) => item.short_id),
                true
            )

            // array of functions that reload each item
            const fetchItemFunctions = items.map((dashboardItem) => async () => {
                try {
                    breakpoint()

                    const refreshedDashboardItem = await api.get(
                        `api/projects/${values.currentTeamId}/insights/${dashboardItem.id}/?${toParams({
                            refresh: true,
                        })}`
                    )
                    breakpoint()

                    // reload the cached results inside the insight's logic
                    if (dashboardItem.filters.insight) {
                        const itemResultLogic = insightLogic({
                            dashboardItemId: dashboardItem.short_id,
                            filters: dashboardItem.filters,
                            cachedResults: refreshedDashboardItem.result,
                        })
                        itemResultLogic.actions.setInsight(
                            { ...dashboardItem, result: refreshedDashboardItem.result },
                            { fromPersistentApi: true }
                        )
                    }

                    dashboardsModel.actions.updateDashboardItem(refreshedDashboardItem)
                    actions.setRefreshStatus(dashboardItem.short_id)
                } catch (e) {
                    if (isBreakpoint(e)) {
                        breakpointTriggered = true
                    } else {
                        actions.setRefreshError(dashboardItem.short_id)
                    }
                }
            })

            // run 4 item reloaders in parallel
            function loadNextPromise(): void {
                if (!breakpointTriggered && fetchItemFunctions.length > 0) {
                    fetchItemFunctions.shift()?.().then(loadNextPromise)
                }
            }
            for (let i = 0; i < 4; i++) {
                void loadNextPromise()
            }

            eventUsageLogic.actions.reportDashboardRefreshed(values.lastRefreshed)
        },
        updateAndRefreshDashboard: async (_, breakpoint) => {
            await breakpoint(200)
            await api.update(`api/projects/${values.currentTeamId}/dashboards/${props.id}`, {
                filters: values.filters,
            })
            actions.refreshAllDashboardItems()
        },
        setDates: ({ dateFrom, dateTo, reloadDashboard }) => {
            if (reloadDashboard) {
                actions.updateAndRefreshDashboard()
            }
            eventUsageLogic.actions.reportDashboardDateRangeChanged(dateFrom, dateTo)
        },
        setDashboardMode: async ({ mode, source }) => {
            // Edit mode special handling
            if (mode === DashboardMode.Fullscreen) {
                document.body.classList.add('fullscreen-scroll')
            } else {
                document.body.classList.remove('fullscreen-scroll')
            }
            if (mode === DashboardMode.Edit) {
                clearDOMTextSelection()
            }

            if (mode) {
                eventUsageLogic.actions.reportDashboardModeToggled(mode, source)
            }
        },
        addGraph: () => {
            if (values.dashboard) {
                router.actions.push(urls.insightNew({ insight: InsightType.TRENDS }))
            }
        },
        setAutoRefresh: () => {
            actions.resetInterval()
        },
        resetInterval: () => {
            if (cache.autoRefreshInterval) {
                window.clearInterval(cache.autoRefreshInterval)
                cache.autoRefreshInterval = null
            }

            if (values.autoRefresh.enabled) {
                cache.autoRefreshInterval = window.setInterval(() => {
                    actions.refreshAllDashboardItems()
                }, values.autoRefresh.interval * 1000)
            }
        },
        loadDashboardItemsSuccess: () => {
            // Initial load of actual data for dashboard items after general dashboard is fetched
            const notYetLoadedItems = values.allItems?.items?.filter((i) => !i.result)
            actions.refreshAllDashboardItems(notYetLoadedItems)
            if (values.shouldReportOnAPILoad) {
                actions.setShouldReportOnAPILoad(false)
                actions.reportDashboardViewed()
            }
        },
        reportDashboardViewed: async (_, breakpoint) => {
            if (values.allItems) {
                eventUsageLogic.actions.reportDashboardViewed(values.allItems, !!props.shareToken)
                await breakpoint(IS_TEST_MODE ? 1 : 10000) // Tests will wait for all breakpoints to finish
                if (router.values.location.pathname === urls.dashboard(values.allItems.id)) {
                    eventUsageLogic.actions.reportDashboardViewed(values.allItems, !!props.shareToken, 10)
                }
            } else {
                // allItems has not loaded yet, report after API request is completed
                actions.setShouldReportOnAPILoad(true)
            }
        },
    }),
})
