import ConfigManager from '@sqltools/core/config-manager';
import { EXT_NAME } from '@sqltools/core/constants';
import { ConnectionInterface } from '@sqltools/core/interface';
import { SQLToolsExtensionPlugin, RequestHandler as RHandler, SQLToolsLanguageClientInterface, SQLToolsExtensionInterface } from '@sqltools/core/interface/plugin';
import { getConnectionDescription, getConnectionId } from '@sqltools/core/utils';
import { logOnCall } from '@sqltools/core/utils/decorators';
import ErrorHandler from '@sqltools/extension/api/error-handler';
import Utils from '@sqltools/extension/api/utils';
import { getSelectedText, quickPick, readInput } from '@sqltools/extension/api/vscode-utils';
import { SidebarConnection, SidebarTable, SidebarView, ConnectionExplorer } from '@sqltools/plugins/connection-manager/explorer';
import ResultsWebview from '@sqltools/plugins/connection-manager/screens/results';
import SettingsWebview from '@sqltools/plugins/connection-manager/screens/settings';
import { commands, QuickPickItem, ExtensionContext, StatusBarAlignment, StatusBarItem, window, workspace } from 'vscode';
import { ConnectionDataUpdatedRequest, ConnectRequest, DisconnectRequest, GetConnectionDataRequest, GetConnectionPasswordRequest, GetConnectionsRequest, RefreshAllRequest, RunCommandRequest } from './contracts';

export default class ConnectionManagerPlugin implements SQLToolsExtensionPlugin {
  public client: SQLToolsLanguageClientInterface;
  public resultsWebview: ResultsWebview;
  public settingsWebview: SettingsWebview;
  public statusBar: StatusBarItem;;
  private context: ExtensionContext;
  private explorer: ConnectionExplorer;

  public handler_connectionDataUpdated: RHandler<typeof ConnectionDataUpdatedRequest> = ({ conn, tables, columns }) => {
    this.explorer.setTreeData(conn, tables, columns);
  }

  // extension commands
  @logOnCall()
  private ext_refreshAll = () => {
    return this.client.sendRequest(RefreshAllRequest);
  }

  @logOnCall()
  private ext_runFromInput = async () => {
    try {
      const query = await readInput('Query', `Type the query to run on ${this.explorer.getActive().name}`);
      await this.ext_executeQuery(query);
    } catch (e) {
      ErrorHandler.create('Error running query.', this.ext_showOutputChannel)(e);
    }
  }

  @logOnCall()
  private ext_showRecords = async (node?: SidebarTable | SidebarView) => {
    try {
      const table = await this._getTableName(node);
      this._openResultsWebview();
      const payload = await this._runConnectionCommandWithArgs('showRecords', table, ConfigManager.previewLimit);
      this.resultsWebview.updateResults(payload);

    } catch (e) {
      ErrorHandler.create('Error while showing table records', this.ext_showOutputChannel)(e);
    }
  }

  @logOnCall()
  private ext_describeTable = async (node?: SidebarTable | SidebarView) => {
    try {
      const table = await this._getTableName(node);
      this._openResultsWebview();
      const payload = await this._runConnectionCommandWithArgs('describeTable', table);
      this.resultsWebview.updateResults(payload);
    } catch (e) {
      ErrorHandler.create('Error while describing table records', this.ext_showOutputChannel)(e);
    }
  }

  @logOnCall()
  private ext_describeFunction() {
    window.showInformationMessage('Not implemented yet.');
  }

  @logOnCall()
  private ext_closeConnection = async (node?: SidebarConnection) => {
    const conn = node ? node.conn : await this._pickConnection(true);
    if (!conn) {
      return;
    }

    return this.client.sendRequest(DisconnectRequest, { conn })
      .then(async () => {
        this.client.telemetry.registerInfoMessage('Connection closed!');
        this.explorer.disconnect(conn as ConnectionInterface);
        this._updateStatusBar();
      }, ErrorHandler.create('Error closing connection'));
  }

  @logOnCall()
  private ext_selectConnection = async (connIdOrNode?: SidebarConnection | string) => {
    if (connIdOrNode) {
      const conn = connIdOrNode instanceof SidebarConnection ? connIdOrNode.conn : this.explorer.getById(connIdOrNode);

      await this._setConnection(conn as ConnectionInterface).catch(ErrorHandler.create('Error opening connection'));
      return;
    }
    this._connect(true).catch(ErrorHandler.create('Error selecting connection'));
  }

  @logOnCall()
  private ext_executeQuery = async (query?: string) => {
    try {
      query = query || await getSelectedText('execute query');
      this._openResultsWebview();
      await this._connect();
      await this._runQuery(query);
    } catch (e) {
      ErrorHandler.create('Error fetching records.', this.ext_showOutputChannel)(e);
    }
  }

  @logOnCall()
  private ext_executeQueryFromFile = async () => {
    // @TODO: read from file and run
    return this.ext_executeQuery(await getSelectedText('execute file', true));
  }

  @logOnCall()
  private ext_showOutputChannel = () => {
    (<any>console).show();
  }

  @logOnCall()
  private ext_saveResults = async (filetype: 'csv' | 'json') => {
    filetype = typeof filetype === 'string' ? filetype : undefined;
    let mode: any = filetype || ConfigManager.defaultExportType;
    if (mode === 'prompt') {
      mode = await quickPick<'csv' | 'json' | undefined>([
        { label: 'Save results as CSV', value: 'csv' },
        { label: 'Save results as JSON', value: 'json' },
      ], 'value', {
        title: 'Select a file type to export',
      });
    }

    if (!mode) return;

    return this.resultsWebview.saveResults(mode);
  }

  private ext_openAddConnectionScreen = () => {
    return this.settingsWebview.show();
  }

  private ext_deleteConnection = async (connIdOrNode?: string | SidebarConnection) => {
    let id: string;
    if (connIdOrNode) {
      id = connIdOrNode instanceof SidebarConnection ? connIdOrNode.getId() : <string>connIdOrNode;
    } else {
      const conn = await this._pickConnection();
      id = conn ? getConnectionId(conn) : undefined;
    }

    if (!id) return;

    const conn = this.explorer.getById(id);

    const res = await window.showInformationMessage(`Are you sure you want to remove ${conn.name}?`, { modal: true }, 'Yes');

    if (!res) return;

    const connList = ConfigManager.connections.filter(c => getConnectionId(c) !== id);
    return workspace.getConfiguration(EXT_NAME.toLowerCase()).update('connections', connList);
  }

  @logOnCall()
  private ext_addConnection(connInfo: ConnectionInterface) {
    if (!connInfo) {
      console.warn('Nothing to do. No parameter received');
      return;
    }
    const connList = ConfigManager.connections;
    connList.push(connInfo);
    return workspace.getConfiguration(EXT_NAME.toLowerCase()).update('connections', connList);
  }

  // internal utils
  private async _getTableName(node?: SidebarTable | SidebarView): Promise<string> {
    if (node && node.value) {
      await this._setConnection(node.conn as ConnectionInterface);
      return node.value;
    }

    const conn = await this._connect();

    return await this._pickTable(conn, 'label');
  }

  private _openResultsWebview() {
    this.resultsWebview.show();
  }
  private async _connect(force = false): Promise<ConnectionInterface> {
    if (!force && this.explorer.getActive()) {
      return this.explorer.getActive();
    }
    const c: ConnectionInterface = await this._pickConnection(true);
    // history.clear();
    return this._setConnection(c);
  }

  private async _pickTable(conn: ConnectionInterface, prop?: string): Promise<string> {
    const { tables } = await this.client.sendRequest(GetConnectionDataRequest, { conn });
    return await quickPick(tables
      .map((table) => {
        return { label: table.name } as QuickPickItem;
      }), prop, {
        matchOnDescription: true,
        matchOnDetail: true,

        title: `Tables in ${conn.database}`,
      });
  }

  private async _pickConnection(connectedOnly = false): Promise<ConnectionInterface> {
    const connections: ConnectionInterface[] = await this.client.sendRequest(GetConnectionsRequest, { connectedOnly });

    if (connections.length === 0 && connectedOnly) return this._pickConnection();

    if (connections.length === 1) return connections[0];

    const sel = (await quickPick(connections.map((c) => {
      return <QuickPickItem>{
        description: c.isConnected ? 'Currently connected' : '',
        detail: getConnectionDescription(c),
        label: c.name,
        value: getConnectionId(c)
      };
    }), 'value', {
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: 'Pick a connection',
      placeHolderDisabled: 'You don\'t have any connections yet.',
      title: 'Connections',
      buttons: [
        {
          iconPath: {
            dark: this.context.asAbsolutePath('icons/add-connection-dark.svg'),
            light: this.context.asAbsolutePath('icons/add-connection-light.svg'),
          },
          tooltip: 'Add new Connection',
          cb: () => commands.executeCommand(`${EXT_NAME}.openAddConnectionScreen`),
        } as any,
      ],
    })) as string;
    return connections.find((c) => getConnectionId(c) === sel);
  }

  private async _runQuery(query: string, addHistory = true) {
    const payload = await this._runConnectionCommandWithArgs('query', query);

    // if (addHistory) history.add(query);
    this.resultsWebview.updateResults(payload);
  }

  private _runConnectionCommandWithArgs(command, ...args) {
    return this.client.sendRequest(RunCommandRequest, { conn: this.explorer.getActive(), command, args });
  }

  private async _askForPassword(c: ConnectionInterface): Promise<string | null> {
    const cachedPass = await this.client.sendRequest(GetConnectionPasswordRequest, { conn: c });
    return cachedPass || await window.showInputBox({

      prompt: `${c.name} password`,
      password: true,
      validateInput: (v) => Utils.isEmpty(v) ? 'Password not provided.' : null,
    });
  }
  private async _setConnection(c?: ConnectionInterface): Promise<ConnectionInterface> {
    let password = null;

    if (c) {
      if (c.askForPassword) password = await this._askForPassword(c);
      if (c.askForPassword && password === null) return;
      c = await this.client.sendRequest(
        ConnectRequest,
        { conn: c, password },
      );
    }
    this._updateStatusBar();
    return this.explorer.getActive();
  }

  private _updateStatusBar() {
    if (!this.statusBar) {
      this.statusBar = window.createStatusBarItem(StatusBarAlignment.Left, 10);
      this.statusBar.tooltip = 'Select a connection';
      this.statusBar.command = `${EXT_NAME}.selectConnection`;
    }
    if (this.explorer.getActive()) {
      this.statusBar.text = `$(database) ${this.explorer.getActive().name}`;
    } else {
      this.statusBar.text = '$(database) Connect';
    }
    if (ConfigManager.showStatusbar) {
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }

    return this.statusBar;
  }

  public register(extension: SQLToolsExtensionInterface) {
    if (this.client) return; // do not register twice
    this.client = extension.client;
    this.context = extension.context;
    this.explorer = new ConnectionExplorer(this.context);

    this.client.onRequest(ConnectionDataUpdatedRequest, this.handler_connectionDataUpdated);

    // extension stuff
    this.context.subscriptions.push(
      (this.resultsWebview = new ResultsWebview(this.context, this.client)),
      (this.settingsWebview = new SettingsWebview(this.context, )),
      this._updateStatusBar(),
      workspace.onDidCloseTextDocument(this.ext_refreshAll),
      workspace.onDidOpenTextDocument(this.ext_refreshAll),
      this.explorer.onConnectionDidChange(() => this.ext_refreshAll()),
      // register extension commands
      commands.registerCommand(`${EXT_NAME}.addConnection`, this.ext_addConnection),
      commands.registerCommand(`${EXT_NAME}.openAddConnectionScreen`, this.ext_openAddConnectionScreen),
      commands.registerCommand(`${EXT_NAME}.closeConnection`, this.ext_closeConnection),
      commands.registerCommand(`${EXT_NAME}.deleteConnection`, this.ext_deleteConnection),
      commands.registerCommand(`${EXT_NAME}.describeFunction`, this.ext_describeFunction),
      commands.registerCommand(`${EXT_NAME}.describeTable`, this.ext_describeTable),
      commands.registerCommand(`${EXT_NAME}.executeQuery`, this.ext_executeQuery),
      commands.registerCommand(`${EXT_NAME}.executeQueryFromFile`, this.ext_executeQueryFromFile),
      commands.registerCommand(`${EXT_NAME}.refreshAll`, this.ext_refreshAll),
      commands.registerCommand(`${EXT_NAME}.runFromInput`, this.ext_runFromInput),
      commands.registerCommand(`${EXT_NAME}.saveResults`, this.ext_saveResults),
      commands.registerCommand(`${EXT_NAME}.selectConnection`, this.ext_selectConnection),
      commands.registerCommand(`${EXT_NAME}.showOutputChannel`, this.ext_showOutputChannel),
      commands.registerCommand(`${EXT_NAME}.showRecords`, this.ext_showRecords),
    );


    // hooks
    ConfigManager.addOnUpdateHook(() => {
      this._updateStatusBar();
    });
  }
}