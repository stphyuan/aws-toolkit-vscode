/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as telemetry from '../../shared/telemetry/telemetry'
import {
    CloudWatchLogsData,
    CloudWatchLogsGroupInfo,
    CloudWatchLogsParameters,
    LogStreamRegistry,
    filterLogEventsFromUriComponents,
} from '../registry/logStreamRegistry'
import { createQuickPick, DataQuickPickItem } from '../../shared/ui/pickerPrompter'
import { Wizard } from '../../shared/wizards/wizard'
import { createInputBox } from '../../shared/ui/inputPrompter'
import { createURIFromArgs } from '../cloudWatchLogsUtils'
import { DefaultCloudWatchLogsClient } from '../../shared/clients/cloudWatchLogsClient'
import { CloudWatchLogs } from 'aws-sdk'
import { highlightDocument } from '../document/logStreamDocumentProvider'
import { CancellationError } from '../../shared/utilities/timeoutUtils'
import { localize } from 'vscode-nls'
import { getLogger } from '../../shared/logger'

export async function searchLogGroup(registry: LogStreamRegistry): Promise<void> {
    let result: telemetry.Result = 'Succeeded'
    const regionCode = 'us-west-2'
    const client = new DefaultCloudWatchLogsClient(regionCode)
    const logGroups = await logGroupsToArray(client.describeLogGroups())
    const response = await new SearchLogGroupWizard(logGroups).run()
    if (response) {
        const logGroupInfo: CloudWatchLogsGroupInfo = {
            groupName: response.logGroup,
            regionName: regionCode,
        }

        const parameters: CloudWatchLogsParameters = {
            limit: registry.configuration.get('limit', 10000),
            filterPattern: response.filterPattern,
        }

        const uri = createURIFromArgs(logGroupInfo, parameters)
        const initialStreamData: CloudWatchLogsData = {
            data: [],
            parameters: parameters,
            busy: false,
            logGroupInfo: logGroupInfo,
            retrieveLogsFunction: filterLogEventsFromUriComponents,
        }
        // Currently displays nothing if update log fails in non-cancellationError. (don't want this)

        try {
            await registry.registerLog(uri, initialStreamData)
            const doc = await vscode.workspace.openTextDocument(uri) // calls back into the provider
            vscode.languages.setTextDocumentLanguage(doc, 'log')
            const textEditor = await vscode.window.showTextDocument(doc, { preview: false })
            registry.setTextEditor(uri, textEditor)
            highlightDocument(registry, uri)
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
                if (event.document.uri.toString() === doc.uri.toString()) {
                    highlightDocument(registry, uri)
                }
            })
        } catch (err) {
            if (CancellationError.isUserCancelled(err)) {
                getLogger().debug('cwl: User Cancelled Search')
                result = 'Cancelled'
            } else {
                const error = err as Error
                vscode.window.showErrorMessage(
                    localize(
                        'AWS.cwl.searchLogGroup.errorRetrievingLogs',
                        'Error retrieving logs for Log Group {0} : {1}',
                        logGroupInfo.groupName,
                        error.message
                    )
                )
            }
        }
    } else {
        result = 'Cancelled'
    }
    telemetry.recordCloudwatchlogsOpenStream({ result })
}

async function logGroupsToArray(logGroups: AsyncIterableIterator<CloudWatchLogs.LogGroup>): Promise<string[]> {
    const logGroupsArray = []
    for await (const logGroupObject of logGroups) {
        logGroupObject.logGroupName && logGroupsArray.push(logGroupObject.logGroupName)
    }
    return logGroupsArray
}

export function createLogGroupPrompter(logGroups: string[]) {
    const options = logGroups.map<DataQuickPickItem<string>>(logGroupString => ({
        label: logGroupString,
        data: logGroupString,
    }))

    return createQuickPick(options, {
        title: 'Select Log Group',
        placeholder: 'Enter text here',
    })
}

export function createFilterpatternPrompter() {
    return createInputBox({
        title: 'Keyword Search',
        placeholder: 'Enter text here',
    })
}

export interface SearchLogGroupWizardResponse {
    logGroup: string
    filterPattern: string
}

export class SearchLogGroupWizard extends Wizard<SearchLogGroupWizardResponse> {
    public constructor(logGroups: string[]) {
        super()

        this.form.logGroup.bindPrompter(() => createLogGroupPrompter(logGroups))
        this.form.filterPattern.bindPrompter(createFilterpatternPrompter)
    }
}
