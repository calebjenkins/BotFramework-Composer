// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'path';

import { BotIndexer, indexer } from '@bfc/indexers';
import {
  BotProjectFile,
  BotProjectSpace,
  BotProjectSpaceSkill,
  convertSkillsToDictionary,
  migrateSkillsForExistingBots,
  dereferenceDefinitions,
  fetchEndpointNameForSkill,
  DialogInfo,
  DialogSetting,
  getManifestNameFromUrl,
  LuFile,
  QnAFile,
  SensitiveProperties,
  RootBotManagedProperties,
  defaultPublishConfig,
  LgFile,
  QnABotTemplateId,
  ILUFeaturesConfig,
  SDKKinds,
} from '@bfc/shared';
import formatMessage from 'format-message';
import camelCase from 'lodash/camelCase';
import objectGet from 'lodash/get';
import objectSet from 'lodash/set';
import cloneDeep from 'lodash/cloneDeep';
import { stringify } from 'query-string';
import { CallbackInterface } from 'recoil';
import { v4 as uuid } from 'uuid';
import isEmpty from 'lodash/isEmpty';

import { checkIfDotnetVersionMissing, checkIfFunctionsMissing } from '../../../utils/runtimeErrors';
import { BASEURL, BotStatus } from '../../../constants';
import settingStorage from '../../../utils/dialogSettingStorage';
import { getUniqueName } from '../../../utils/fileUtil';
import httpClient from '../../../utils/httpUtil';
import languageStorage from '../../../utils/languageStorage';
import luFileStatusStorage from '../../../utils/luFileStatusStorage';
import { getReferredLuFiles } from '../../../utils/luUtil';
import { navigateTo } from '../../../utils/navigation';
import qnaFileStatusStorage from '../../../utils/qnaFileStatusStorage';
import { getReferredQnaFiles, migrateQnAFiles } from '../../../utils/qnaUtil';
import {
  botDiagnosticsState,
  botDisplayNameState,
  botEnvironmentState,
  botErrorState,
  botNameIdentifierState,
  botProjectFileState,
  botProjectIdsState,
  botProjectSpaceLoadedState,
  botStatusState,
  projectReadmeState,
  currentProjectIdState,
  dialogSchemasState,
  dialogState,
  filePersistenceState,
  formDialogSchemaIdsState,
  formDialogSchemaState,
  jsonSchemaFilesState,
  localeState,
  locationState,
  projectMetaDataState,
  recentProjectsState,
  schemasState,
  settingsState,
  skillManifestsState,
  dialogIdsState,
  showCreateQnADialogState,
  createQnAOnState,
  botEndpointsState,
  dispatcherState,
  warnAboutDotNetState,
  warnAboutFunctionsState,
  showGetStartedTeachingBubbleState,
  showErrorDiagnosticsState,
  showWarningDiagnosticsState,
} from '../../atoms';
import * as botstates from '../../atoms/botState';
import lgWorker from '../../parsers/lgWorker';
import luWorker from '../../parsers/luWorker';
import qnaWorker from '../../parsers/qnaWorker';
import FilePersistence from '../../persistence/FilePersistence';
import {
  botRuntimeOperationsSelector,
  luFilesSelectorFamily,
  qnaFilesSelectorFamily,
  rootBotProjectIdSelector,
} from '../../selectors';
import { undoHistoryState } from '../../undo/history';
import UndoHistory from '../../undo/undoHistory';
import { logMessage, setError } from '../shared';
import { setRootBotSettingState } from '../setting';
import { lgFilesSelectorFamily } from '../../selectors/lg';
import { getPublishProfileFromPayload } from '../../../utils/electronUtil';

import { crossTrainConfigState, projectIndexingState } from './../../atoms/botState';
import { recognizersSelectorFamily } from './../../selectors/recognizers';

export const resetBotStates = ({ reset }: CallbackInterface, projectId: string) => {
  const botStates = Object.keys(botstates);
  botStates.forEach((state) => {
    const currentRecoilAtom: any = botstates[state];
    reset(currentRecoilAtom(projectId));
  });
  reset(botEndpointsState);
  reset(showErrorDiagnosticsState);
  reset(showWarningDiagnosticsState);
};

export const setErrorOnBotProject = async (
  callbackHelpers: CallbackInterface,
  projectId: string,
  botName: string,
  payload: any
) => {
  const { set } = callbackHelpers;
  if (payload?.response?.data?.message) {
    set(botErrorState(projectId), payload.response.data);
  } else {
    set(botErrorState(projectId), payload);
  }
  if (payload != null) logMessage(callbackHelpers, `Error loading ${botName}: ${JSON.stringify(payload)}`);
};

export const flushExistingTasks = async (callbackHelpers: CallbackInterface) => {
  const { snapshot, reset } = callbackHelpers;
  const projectIds = await snapshot.getPromise(botProjectIdsState);
  const botRuntimeOperations = await snapshot.getPromise(botRuntimeOperationsSelector);

  reset(botProjectSpaceLoadedState);
  reset(botProjectIdsState);

  const result = projectIds.map(async (projectId) => {
    await botRuntimeOperations?.stopBot(projectId);
    resetBotStates(callbackHelpers, projectId);
  });

  const workers = [lgWorker, luWorker, qnaWorker].map(async (worker) => {
    await worker.flush();
  });
  await Promise.all([...result, ...workers]);
};

// merge sensitive values in localStorage
const mergeLocalStorage = (projectId: string, settings: DialogSetting) => {
  const localSetting = settingStorage.get(projectId);
  const mergedSettings = { ...settings };
  if (localSetting) {
    for (const property of SensitiveProperties) {
      if (RootBotManagedProperties.includes(property)) {
        continue;
      }
      const value = objectGet(localSetting, property);
      if (value) {
        objectSet(mergedSettings, property, value);
      } else {
        objectSet(mergedSettings, property, ''); // set those key back, because that were omit after persisited
      }
    }
  }
  return mergedSettings;
};

const mergeLuisName = (settings: DialogSetting, botName: string) => {
  const mergedSettings = cloneDeep(settings);
  const luisName = objectGet(mergedSettings, 'luis.name', '') || botName;
  objectSet(mergedSettings, 'luis.name', luisName);
  return mergedSettings;
};

export const mergePropertiesManagedByRootBot = (projectId: string, rootBotProjectId, settings: DialogSetting) => {
  const localSetting = settingStorage.get(rootBotProjectId);
  const mergedSettings = cloneDeep(settings);
  if (localSetting) {
    for (const property of RootBotManagedProperties) {
      const rootValue = objectGet(localSetting, property, {}).root;
      if (projectId === rootBotProjectId) {
        objectSet(mergedSettings, property, rootValue ?? '');
      }
      if (projectId !== rootBotProjectId) {
        const skillValue = objectGet(localSetting, property, {})[projectId];
        objectSet(mergedSettings, property, skillValue ?? '');
      }
    }
  }
  return mergedSettings;
};

export const getSensitiveProperties = (settings: DialogSetting) => {
  const sensitiveProperties = {};
  for (const property of SensitiveProperties) {
    const value = objectGet(settings, property, '');
    objectSet(sensitiveProperties, property, value);
  }
  return sensitiveProperties;
};

export const getMergedSettings = (projectId: string, settings: DialogSetting, botName: string): DialogSetting => {
  let mergedSettings = mergeLocalStorage(projectId, settings);
  mergedSettings = mergeLuisName(mergedSettings, botName);
  if (Array.isArray(mergedSettings.skill)) {
    const skillsArr = mergedSettings.skill.map((skillData) => ({ ...skillData }));
    mergedSettings.skill = convertSkillsToDictionary(skillsArr);
  }
  return mergedSettings;
};

export const navigateToBot = (
  callbackHelpers: CallbackInterface,
  projectId: string,
  mainDialog?: string,
  urlSuffix?: string
) => {
  if (projectId) {
    const { set } = callbackHelpers;
    set(currentProjectIdState, projectId);
    let url = `/bot/${projectId}`;
    if (mainDialog) {
      url += `/dialogs/${mainDialog}`;
    }
    if (urlSuffix) {
      // deep link was provided to creation flow (base64 encoded to make query string parsing easier)
      urlSuffix = atob(urlSuffix);
      url = `/bot/${projectId}/${urlSuffix}`;
    }
    navigateTo(url);
  }
};

export const navigateToSkillBot = (rootProjectId: string, skillId: string, mainDialog?: string) => {
  if (rootProjectId && skillId) {
    let url = `/bot/${rootProjectId}/skill/${skillId}`;
    if (mainDialog) url += `/dialogs/${mainDialog}`;
    navigateTo(url);
  }
};

const emptyLgFile = (id: string, content: string): LgFile => {
  return {
    id,
    content,
    diagnostics: [],
    templates: [],
    allTemplates: [],
    imports: [],
    isContentUnparsed: true,
  };
};

const emptyLuFile = (id: string, content: string): LuFile => {
  return {
    id,
    content,
    diagnostics: [],
    intents: [],
    allIntents: [],
    empty: true,
    resource: {
      Sections: [],
      Errors: [],
      Content: '',
    },
    imports: [],
    isContentUnparsed: true,
  };
};

const emptyQnaFile = (id: string, content: string): QnAFile => {
  return {
    id,
    content,
    diagnostics: [],
    qnaSections: [],
    imports: [],
    options: [],
    empty: true,
    resource: {
      Sections: [],
      Errors: [],
      Content: '',
    },
    isContentUnparsed: true,
  };
};

const parseAllAssets = async ({ set }: CallbackInterface, projectId: string, botFiles: any) => {
  const { luFiles, lgFiles, qnaFiles, mergedSettings, dialogs, recognizers } = botFiles;
  const luFeaturesMap: { [key: string]: ILUFeaturesConfig } = {};
  for (const { id } of luFiles) {
    const isOrchestartor = recognizers.some(
      (f) => f.id === `${id}.lu.dialog` && f.content.$kind === SDKKinds.OrchestratorRecognizer
    );
    const luFeatures = { ...mergedSettings.luFeatures, isOrchestartor };
    luFeaturesMap[id] = luFeatures;
  }
  const [parsedLgFiles, parsedLuFiles, parsedQnaFiles] = await Promise.all([
    lgWorker.parseAll(projectId, lgFiles),
    luWorker.parseAll(luFiles, luFeaturesMap),
    qnaWorker.parseAll(qnaFiles),
  ]);

  // migrate script move qna pairs in *.qna to *-manual.source.qna.
  const locales = mergedSettings.languages;
  const dialogIds = dialogs.map((d) => d.id);
  const migratedQnAFiles = migrateQnAFiles(projectId, dialogIds, parsedQnaFiles as QnAFile[], locales);

  set(lgFilesSelectorFamily(projectId), (oldFiles) => {
    return oldFiles.map((item) => {
      const file = (parsedLgFiles as LgFile[]).find((file) => file.id === item.id);
      return file && item.isContentUnparsed ? file : item;
    });
  });

  set(luFilesSelectorFamily(projectId), (oldFiles) => {
    return oldFiles.map((item) => {
      const file = (parsedLuFiles as LuFile[]).find((file) => file.id === item.id);
      return file && item.isContentUnparsed ? file : item;
    });
  });

  set(qnaFilesSelectorFamily(projectId), (oldFiles) => {
    return migratedQnAFiles.map((newFile) => {
      const oldFile = oldFiles.find((file) => file.id === newFile.id);
      return oldFile && !oldFile.isContentUnparsed ? oldFile : newFile;
    });
  });

  set(projectIndexingState(projectId), false);
};

export const loadProjectData = async (data) => {
  const { files, botName, settings, id: projectId } = data;
  const mergedSettings = getMergedSettings(projectId, settings, botName);
  const indexedFiles = indexer.index(files, botName);

  const { lgResources, luResources, qnaResources } = indexedFiles;

  //parse all resources with worker
  lgWorker.addProject(projectId);

  const lgFiles = lgResources.map(({ id, content }) => emptyLgFile(id, content));
  const luFiles = luResources.map(({ id, content }) => emptyLuFile(id, content));
  const qnaFiles = qnaResources.map(({ id, content }) => emptyQnaFile(id, content));

  const assets = { ...indexedFiles, lgFiles, luFiles, qnaFiles };
  //Validate all files
  const diagnostics = BotIndexer.validate({
    ...assets,
    setting: settings,
    botProjectFile: assets.botProjectSpaceFiles[0],
  });

  const botFiles = { ...assets, mergedSettings, diagnostics };

  return {
    botFiles,
    projectData: data,
    error: undefined,
  };
};

export const fetchProjectDataByPath = async (
  path: string,
  storageId,
  isRootBot: boolean
): Promise<{ botFiles: any; projectData: any; error: any }> => {
  try {
    const response = await httpClient.put(`/projects/open`, { path, storageId, isRootBot });
    const projectData = await loadProjectData(response.data);
    return projectData;
  } catch (ex) {
    return {
      botFiles: undefined,
      projectData: undefined,
      error: ex,
    };
  }
};

export const fetchProjectDataById = async (projectId): Promise<{ botFiles: any; projectData: any; error: any }> => {
  try {
    const response = await httpClient.get(`/projects/${projectId}`);
    const projectData = await loadProjectData(response.data);
    return projectData;
  } catch (ex) {
    return {
      botFiles: undefined,
      projectData: undefined,
      error: ex,
    };
  }
};

export const handleProjectFailure = (callbackHelpers: CallbackInterface, error) => {
  const isDotnetError = checkIfDotnetVersionMissing({
    message: error.response?.data?.message ?? error.message ?? '',
  });
  const isFunctionsError = checkIfFunctionsMissing({
    message: error.response?.data?.message ?? error.message ?? '',
  });

  if (isDotnetError) {
    callbackHelpers.set(warnAboutDotNetState, true);
  } else if (isFunctionsError) {
    callbackHelpers.set(warnAboutFunctionsState, true);
  } else {
    callbackHelpers.set(warnAboutDotNetState, false);
    callbackHelpers.set(warnAboutFunctionsState, false);
    setError(callbackHelpers, error);
  }
};

export const processSchema = (projectId: string, schema: any) => ({
  ...schema,
  definitions: dereferenceDefinitions(schema.definitions),
});

// if user set value in terminal or appsetting.json, it should update the value in localStorage
export const refreshLocalStorage = (projectId: string, settings: DialogSetting) => {
  for (const property of SensitiveProperties) {
    const value = objectGet(settings, property);
    if (value) {
      settingStorage.setField(projectId, property, value);
    }
  }
};

export const updateLuFilesStatus = (projectId: string, luFiles: LuFile[]) => {
  const status = luFileStatusStorage.get(projectId);
  return luFiles.map((luFile) => {
    if (typeof status[luFile.id] === 'boolean') {
      return { ...luFile, published: status[luFile.id] };
    } else {
      return { ...luFile, published: false };
    }
  });
};

export const initLuFilesStatus = (projectId: string, luFiles: LuFile[], dialogs: DialogInfo[]) => {
  luFileStatusStorage.checkFileStatus(
    projectId,
    getReferredLuFiles(luFiles, dialogs).map((file) => file.id)
  );
  return updateLuFilesStatus(projectId, luFiles);
};

export const updateQnaFilesStatus = (projectId: string, qnaFiles: QnAFile[]) => {
  const status = qnaFileStatusStorage.get(projectId);
  return qnaFiles.map((qnaFile) => {
    if (typeof status[qnaFile.id] === 'boolean') {
      return { ...qnaFile, published: status[qnaFile.id] };
    } else {
      return { ...qnaFile, published: false };
    }
  });
};

export const initQnaFilesStatus = (projectId: string, qnaFiles: QnAFile[], dialogs: DialogInfo[]) => {
  qnaFileStatusStorage.checkFileStatus(
    projectId,
    getReferredQnaFiles(qnaFiles, dialogs).map((file) => file.id)
  );
  return updateQnaFilesStatus(projectId, qnaFiles);
};

export const isAdaptiveRuntime = (settings): boolean => {
  return settings?.runtime?.key?.match(/^adaptive-runtime/) ? true : false;
};

export const isOldCustomRuntime = (settings): boolean => {
  const keys = ['node-azurewebapp', 'csharp-azurewebapp'];
  return keys.includes(settings?.runtime?.key);
};

export const isPVA = (settings): boolean => {
  return settings?.publishTargets?.some((target) => target.type === 'pva-publish-composer');
};

export const initBotState = async (callbackHelpers: CallbackInterface, data: any, botFiles: any) => {
  const { set } = callbackHelpers;
  const { botName, botEnvironment, location, readme, schemas, settings, id: projectId, diagnostics } = data;
  const {
    dialogs,
    dialogSchemas,
    luFiles,
    lgFiles,
    qnaFiles,
    jsonSchemaFiles,
    formDialogSchemas,
    skillManifests,
    mergedSettings,
    recognizers,
    crossTrainConfig,
  } = botFiles;
  const storedLocale = languageStorage.get(botName)?.locale;
  const locale = settings.languages.includes(storedLocale) ? storedLocale : settings.defaultLanguage;
  languageStorage.setLocale(botName, locale);
  try {
    schemas.sdk.content = processSchema(projectId, schemas.sdk.content);
  } catch (err) {
    const diagnostics = schemas.diagnostics ?? [];
    diagnostics.push(err.message);
    schemas.diagnostics = diagnostics;
  }

  let mainDialog = '';
  const dialogIds: string[] = [];

  for (const dialog of dialogs) {
    if (dialog.isRoot) {
      mainDialog = dialog.id;
    }

    set(dialogState({ projectId, dialogId: dialog.id }), dialog);
    dialogIds.push(dialog.id);
  }

  set(dialogIdsState(projectId), dialogIds);
  set(recognizersSelectorFamily(projectId), recognizers);
  set(crossTrainConfigState(projectId), crossTrainConfig);

  // Form dialogs
  set(
    formDialogSchemaIdsState(projectId),
    formDialogSchemas.map((f) => f.id)
  );
  formDialogSchemas.forEach(({ id, content }) => {
    set(formDialogSchemaState({ projectId, schemaId: id }), { id, content });
  });

  set(skillManifestsState(projectId), skillManifests);
  set(luFilesSelectorFamily(projectId), initLuFilesStatus(botName, luFiles, dialogs));
  set(lgFilesSelectorFamily(projectId), lgFiles);
  set(jsonSchemaFilesState(projectId), jsonSchemaFiles);

  set(dialogSchemasState(projectId), dialogSchemas);
  set(botEnvironmentState(projectId), botEnvironment);
  set(botDisplayNameState(projectId), botName);
  set(qnaFilesSelectorFamily(projectId), initQnaFilesStatus(botName, qnaFiles, dialogs));
  set(botStatusState(projectId), BotStatus.inactive);
  set(locationState(projectId), location);
  set(schemasState(projectId), schemas);
  set(localeState(projectId), locale);
  set(botDiagnosticsState(projectId), diagnostics);
  refreshLocalStorage(projectId, settings);
  set(settingsState(projectId), mergedSettings);
  set(projectReadmeState(projectId), readme);

  set(filePersistenceState(projectId), new FilePersistence(projectId));
  set(undoHistoryState(projectId), new UndoHistory(projectId));
  set(projectIndexingState(projectId), true);
  parseAllAssets(callbackHelpers, projectId, botFiles);

  return mainDialog;
};

export const removeRecentProject = async (callbackHelpers: CallbackInterface, path: string) => {
  try {
    const {
      set,
      snapshot: { getPromise },
    } = callbackHelpers;
    const currentRecentProjects = await getPromise(recentProjectsState);
    const filtered = currentRecentProjects.filter((p) => p.path !== path);
    set(recentProjectsState, filtered);
  } catch (ex) {
    logMessage(callbackHelpers, `Error removing recent project: ${ex}`);
  }
};

export const openRemoteSkill = async (
  callbackHelpers: CallbackInterface,
  { manifestUrl, manifestFromZip = { name: '', content: {} }, rootBotProjectId = '', botNameIdentifier = '' }
) => {
  const { set } = callbackHelpers;

  const response = await httpClient.get(`/projects/generateProjectId`);
  const projectId = response.data;
  let manifestResponseData: Record<string, any>;
  let finalManifestUrl = '';
  if (manifestFromZip.name) {
    finalManifestUrl = manifestFromZip.name;
    manifestResponseData = manifestFromZip.content;
  } else {
    finalManifestUrl = manifestUrl;
    const stringified = stringify({
      url: finalManifestUrl,
    });

    manifestResponseData = (
      await httpClient.get(
        `/projects/${rootBotProjectId}/skill/retrieveSkillManifest?${stringified}&ignoreProjectValidation=true`
      )
    ).data;
  }

  set(projectMetaDataState(projectId), {
    isRootBot: false,
    isRemote: true,
  });
  let uniqueSkillNameIdentifier = botNameIdentifier;
  if (!uniqueSkillNameIdentifier) {
    uniqueSkillNameIdentifier = await getSkillNameIdentifier(callbackHelpers, manifestResponseData.name);
  }

  set(botNameIdentifierState(projectId), uniqueSkillNameIdentifier);
  set(botDisplayNameState(projectId), manifestResponseData.name);
  set(locationState(projectId), finalManifestUrl);
  set(skillManifestsState(projectId), [
    {
      content: manifestResponseData,
      id: getManifestNameFromUrl(finalManifestUrl),
      lastModified: new Date().toDateString(),
    },
  ]);
  return { projectId, manifestResponse: manifestResponseData };
};

export const openLocalSkill = async (callbackHelpers, pathToBot: string, storageId, botNameIdentifier: string) => {
  const { set } = callbackHelpers;
  const { projectData, botFiles, error } = await fetchProjectDataByPath(pathToBot, storageId, false);

  if (error) {
    throw error;
  }

  const mainDialog = await initBotState(callbackHelpers, projectData, botFiles);
  set(projectMetaDataState(projectData.id), {
    isRootBot: false,
    isRemote: false,
  });
  set(botNameIdentifierState(projectData.id), botNameIdentifier);
  const currentBotProjectFileIndexed: BotProjectFile = botFiles.botProjectSpaceFiles[0];
  set(botProjectFileState(projectData.id), currentBotProjectFileIndexed);

  return {
    projectId: projectData.id,
    mainDialog,
  };
};

export const migrateToV2 = async (
  callbackHelpers,
  oldProjectId: string,
  name: string,
  description: string,
  location: string,
  runtimeLanguage: string,
  runtimeType: string
) => {
  const jobId = await httpClient.post(`projects/migrate`, {
    storageId: 'default',
    oldProjectId,
    name,
    description,
    location,
    runtimeLanguage,
    runtimeType,
  });
  return jobId;
};

const addProjectToBotProjectSpace = (set, projectId: string, skillCt: number) => {
  let isBotProjectLoaded = false;
  set(botProjectIdsState, (current: string[]) => {
    const botProjectIds = [...current, projectId];
    if (botProjectIds.length === skillCt) {
      isBotProjectLoaded = true;
    }
    return botProjectIds;
  });
  if (isBotProjectLoaded) {
    set(botProjectSpaceLoadedState, true);
  }
};

const handleSkillLoadingFailure = (callbackHelpers, { isRemote, ex, skillNameIdentifier }) => {
  const { set } = callbackHelpers;
  // Generating a dummy project id which will be replaced by the user from the UI.
  const projectId = uuid();
  set(projectMetaDataState(projectId), {
    isRootBot: false,
    isRemote,
  });
  set(botDisplayNameState(projectId), skillNameIdentifier);
  set(botNameIdentifierState(projectId), skillNameIdentifier);
  setErrorOnBotProject(callbackHelpers, projectId, skillNameIdentifier, ex);
  return projectId;
};

export const openRootBotAndSkills = async (callbackHelpers: CallbackInterface, data, storageId = 'default') => {
  const { projectData, botFiles } = data;
  const { set, snapshot } = callbackHelpers;
  const dispatcher = await snapshot.getPromise(dispatcherState);

  const mainDialog = await initBotState(callbackHelpers, projectData, botFiles);
  const rootBotProjectId = projectData.id;
  const { name, location } = projectData;
  const { mergedSettings } = botFiles;

  set(botNameIdentifierState(rootBotProjectId), camelCase(name));
  set(botProjectIdsState, [rootBotProjectId]);
  // Get the publish types on opening
  dispatcher.getPublishTargetTypes(rootBotProjectId);
  // Get the status of the bot on opening if it was opened and run in another window.
  dispatcher.getPublishStatus(rootBotProjectId, defaultPublishConfig);
  if (botFiles?.botProjectSpaceFiles?.length) {
    const currentBotProjectFileIndexed: BotProjectFile = botFiles.botProjectSpaceFiles[0];

    if (mergedSettings.skill) {
      const { botProjectFile, skillSettings } = migrateSkillsForExistingBots(
        currentBotProjectFileIndexed.content,
        mergedSettings.skill
      );
      if (!isEmpty(skillSettings)) {
        setRootBotSettingState(callbackHelpers, rootBotProjectId, {
          ...mergedSettings,
          skill: skillSettings,
        });
      }
      currentBotProjectFileIndexed.content = botProjectFile;
    }

    const currentBotProjectFile: BotProjectSpace = currentBotProjectFileIndexed.content;

    set(botProjectFileState(rootBotProjectId), currentBotProjectFileIndexed);

    const skills: { [skillId: string]: BotProjectSpaceSkill } = currentBotProjectFile.skills;

    const totalProjectsCount = Object.keys(skills).length + 1;
    if (totalProjectsCount > 1) {
      for (const nameIdentifier in skills) {
        const skill = skills[nameIdentifier];
        let skillPromise;
        let isRemote = false;
        if (!skill.remote && skill.workspace) {
          const rootBotPath = location;
          const skillPath = skill.workspace;
          const absoluteSkillPath = path.join(rootBotPath, skillPath);
          skillPromise = openLocalSkill(callbackHelpers, absoluteSkillPath, storageId, nameIdentifier);
        } else if (skill.manifest) {
          isRemote = true;
          skillPromise = openRemoteSkill(callbackHelpers, {
            manifestUrl: skill.manifest,
            rootBotProjectId: projectData.id,
            botNameIdentifier: nameIdentifier,
          });
        }
        if (skillPromise) {
          skillPromise
            .then(({ projectId, manifestResponse }) => {
              addProjectToBotProjectSpace(set, projectId, totalProjectsCount);
              const matchedEndpoint = fetchEndpointNameForSkill(mergedSettings, nameIdentifier, manifestResponse);
              if (matchedEndpoint) {
                dispatcher.updateEndpointNameInBotProjectFile(nameIdentifier, matchedEndpoint);
              }
              dispatcher.getPublishStatus(projectId, defaultPublishConfig);
            })
            .catch((ex) => {
              const projectId = handleSkillLoadingFailure(callbackHelpers, {
                isRemote,
                skillNameIdentifier: nameIdentifier,
                ex,
              });
              addProjectToBotProjectSpace(set, projectId, totalProjectsCount);
            });
        }
      }
    } else {
      //only contains rootBot
      set(botProjectSpaceLoadedState, true);
    }
  } else {
    // Should never hit here as all projects should have a botproject file
    throw new Error(formatMessage('Bot project file does not exist.'));
  }

  set(currentProjectIdState, rootBotProjectId);
  return {
    mainDialog,
    projectId: rootBotProjectId,
    requiresMigrate: !isAdaptiveRuntime(botFiles.mergedSettings) && !isPVA(botFiles.mergedSettings),
    hasOldCustomRuntime: isOldCustomRuntime(botFiles.mergedSettings),
  };
};

export const postRootBotCreation = async (
  callbackHelpers,
  projectId,
  botFiles,
  projectData,
  templateId,
  profile,
  source,
  projectIdCache
) => {
  if (settingStorage.get(projectId)) {
    settingStorage.remove(projectId);
  }
  const { mainDialog } = await openRootBotAndSkills(callbackHelpers, { botFiles, projectData });
  callbackHelpers.set(projectMetaDataState(projectId), {
    isRootBot: true,
    isRemote: false,
  });
  // if create from QnATemplate, continue creation flow.
  if (templateId === QnABotTemplateId) {
    callbackHelpers.set(createQnAOnState, { projectId, dialogId: mainDialog });
    callbackHelpers.set(showCreateQnADialogState(projectId), true);
  }

  callbackHelpers.set(botProjectIdsState, [projectId]);

  if (profile) {
    // ABS Create Flow, update publishProfile after create project
    const dispatcher = await callbackHelpers.snapshot.getPromise(dispatcherState);
    const newProfile = await getPublishProfileFromPayload(profile, source);

    newProfile && dispatcher.setPublishTargets([newProfile], projectId);
  }
  projectIdCache.set(projectId);
  callbackHelpers.set(showGetStartedTeachingBubbleState, true);
  // navigate to the new get started section
  navigateToBot(callbackHelpers, projectId, undefined, btoa('dialogs'));
};

export const openRootBotAndSkillsByPath = async (callbackHelpers: CallbackInterface, path: string, storageId) => {
  const data = await fetchProjectDataByPath(path, storageId, true);
  if (data.error) {
    throw data.error;
  }
  return await openRootBotAndSkills(callbackHelpers, data, storageId);
};

export const openRootBotAndSkillsByProjectId = async (callbackHelpers: CallbackInterface, projectId: string) => {
  const data = await fetchProjectDataById(projectId);
  if (data.error) {
    throw data.error;
  }

  return await openRootBotAndSkills(callbackHelpers, data);
};

export const saveProject = async (callbackHelpers, oldProjectData) => {
  const { oldProjectId, name, description, location } = oldProjectData;
  const response = await httpClient.post(`/projects/${oldProjectId}/project/saveAs`, {
    storageId: 'default',
    name,
    description,
    location,
  });
  const data = await loadProjectData(response.data);
  if (data.error) {
    throw data.error;
  }
  const result = openRootBotAndSkills(callbackHelpers, data);
  return result;
};

export const getSkillNameIdentifier = async (
  callbackHelpers: CallbackInterface,
  displayName: string
): Promise<string> => {
  const { snapshot } = callbackHelpers;
  const rootBotProjectId = await snapshot.getPromise(rootBotProjectIdSelector);
  if (rootBotProjectId) {
    const { content: botProjectFile } = await snapshot.getPromise(botProjectFileState(rootBotProjectId));
    return getUniqueName(Object.keys(botProjectFile.skills), camelCase(displayName));
  }
  return '';
};

export const checkIfBotExistsInBotProjectFile = async (
  callbackHelpers: CallbackInterface,
  pathOrManifest: string,
  remote?: boolean
) => {
  const { snapshot } = callbackHelpers;
  const rootBotProjectId = await snapshot.getPromise(rootBotProjectIdSelector);
  if (!rootBotProjectId) {
    throw new Error(formatMessage('The root bot is not a bot project'));
  }
  const rootBotLocation = await snapshot.getPromise(locationState(rootBotProjectId));
  const { content: botProjectFile } = await snapshot.getPromise(botProjectFileState(rootBotProjectId));

  if (rootBotLocation === pathOrManifest) {
    return true;
  }

  for (const uniqueSkillName in botProjectFile.skills) {
    const { manifest, workspace } = botProjectFile.skills[uniqueSkillName];
    if (remote) {
      if (manifest === pathOrManifest) {
        return true;
      }
    } else {
      if (workspace) {
        const absolutePathOfSkill = path.join(rootBotLocation, workspace);
        if (pathOrManifest === absolutePathOfSkill) {
          return true;
        }
      }
    }
  }
  return false;
};

export const getMemoryVariables = async (projectId: string, options?: { signal: AbortSignal }) => {
  // eslint-disable-next-line no-underscore-dangle
  const fetchHeaders = { 'X-CSRF-Token': window.__csrf__ };
  const res = await fetch(`${BASEURL}/projects/${projectId}/variables`, {
    headers: fetchHeaders,
    signal: options?.signal,
  });
  const json = (await res.json()) as { variables: string[] };
  return json.variables ?? [];
};
