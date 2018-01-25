// tslint:disable-next-line:max-line-length
import {
  Array1D,
  Array2D,
  CostReduction,
  FeedEntry,
  Graph,
  InCPUMemoryShuffledInputProviderBuilder,
  NDArrayMath,
  NDArrayMathGPU,
  Session,
  SGDOptimizer,
  Tensor,
  Initializer,
  NDArrayInitializer,
  VarianceScalingInitializer,
  ZerosInitializer,
  util
} from 'deeplearn';
// import * as FileSaver from 'file-saver';

export class HappyModel {
  // Runs training.
  session: Session;

  graph: Graph;

  nodeMap: {};

  // Encapsulates math operations on the CPU and GPU.
  math: NDArrayMath = new NDArrayMathGPU();

  // An optimizer with a certain initial learning rate. Used for training.
  initialLearningRate = 0.042;
  optimizer: SGDOptimizer;

  // Each training batch will be on this many examples.
  batchSize = 200;

  inputTensor: Tensor;
  targetTensor: Tensor;
  costTensor: Tensor;
  predictionTensor: Tensor;

  // Maps tensors to InputProviders.
  feedEntries: FeedEntry[];

  constructor() {
    this.optimizer = new SGDOptimizer(this.initialLearningRate);
    this.nodeMap = {};
  }

  /**
   * Constructs the graph of the model. Call this method before training.
   */
  setupSession( happyFaces: number[][], sadFaces: number[][], weights?: any ): void {
    console.log(happyFaces);
    const graph = new Graph();

    // This tensor contains the input. In this case, it is a scalar.
    this.inputTensor = graph.placeholder('input number values to add', [2500]);

    // This tensor contains the target.
    this.targetTensor = graph.placeholder('output value', [1]);

    // Create 3 fully connected layers, each with half the number of nodes of
    // the previous layer. The first one has 16 nodes.
    let fullyConnectedLayer =
        this.createFullyConnectedLayer(graph, this.inputTensor, 0, 64, weights);

    // Create fully connected layer 1, which has 8 nodes.
    fullyConnectedLayer =
        this.createFullyConnectedLayer(graph, fullyConnectedLayer, 1, 32, weights);

    // Create fully connected layer 2, which has 4 nodes.
    fullyConnectedLayer =
        this.createFullyConnectedLayer(graph, fullyConnectedLayer, 2, 8, weights);

    this.predictionTensor =
        this.createFullyConnectedLayer(graph, fullyConnectedLayer, 3, 1, weights);

    // We will optimize using mean squared loss.
    this.costTensor =
        graph.meanSquaredCost(this.targetTensor, this.predictionTensor);

    // Create the session only after constructing the graph.
    this.session = new Session(graph, this.math);
    const nodes = graph.getNodes();
    const node: any = nodes[ 2 ];
    nodes.forEach( (n, index) => {
      this.nodeMap[ n.name ] = index;
    } );
    console.log( nodes );
    console.log(this.nodeMap);
    console.log( this.session );
    this.graph = graph;
    // console.log(graph.getNodes()[2].data);
    // Generate the data that will be used to train the model.
    if ( happyFaces.length && sadFaces.length ) {
      this.generateTrainingData( happyFaces, sadFaces );
    }
  }

  /**
   * Trains one batch for one iteration. Call this method multiple times to
   * progressively train. Calling this function transfers data from the GPU in
   * order to obtain the current loss on training data.
   *
   * If shouldFetchCost is true, returns the mean cost across examples in the
   * batch. Otherwise, returns -1. We should only retrieve the cost now and then
   * because doing so requires transferring data from the GPU.
   */
  train1Batch(shouldFetchCost: boolean, step): number {
    // Every 42 steps, lower the learning rate by 15%.
    const learningRate =
    this.initialLearningRate * Math.pow(0.85, Math.floor(step / 42));
    this.optimizer.setLearningRate(learningRate);

    // Train 1 batch.
    let costValue = -1;
    this.math.scope(() => {
      const cost = this.session.train(
          this.costTensor, this.feedEntries, this.batchSize, this.optimizer,
          shouldFetchCost ? CostReduction.MEAN : CostReduction.NONE);

      if (!shouldFetchCost) {
        // We only train. We do not compute the cost.
        return;
      }

      // Compute the cost (by calling get), which requires transferring data
      // from the GPU.
      costValue = cost.get();
    });
    return costValue;
  }

  predict(numbers: number[]): number[] {
    let complementColor: number[] = [];
    this.math.scope((keep, track) => {
      const mapping = [{
        tensor: this.inputTensor,
        data: Array1D.new(numbers),
      }];
      const evalOutput = this.session.eval(this.predictionTensor, mapping);
      const values = evalOutput.getValues();
      const colors = Array.prototype.slice.call(values);

      // Make sure the values are within range.
      complementColor = colors;
    });
    return complementColor;
  }

  normalize(val: number, max: number, min: number) {
    return (val - min) / (max - min);
  }

  private createFullyConnectedLayer(
      graph: Graph,
      inputLayer: Tensor,
      layerIndex: number,
      sizeOfThisLayer: number,
      weights?: any
  ) {
    const wShape: [number, number] = [util.sizeFromShape(inputLayer.shape), sizeOfThisLayer];
    let weightsInitializer: Initializer;
    let biasInitializer: Initializer;
    if ( weights != null ) {
      let layerWeights = weights.find( w => w.name === `fully_connected_${layerIndex}-weights` );
      layerWeights = Object.keys( layerWeights.values ).map( w => layerWeights.values[ w ] );

      let layerBias = weights.find( w => w.name === `fully_connected_${layerIndex}-bias` );
      layerBias = Object.keys( layerBias.values ).map( w => layerBias.values[ w ] );

      weightsInitializer =
        new NDArrayInitializer(Array2D.new(wShape, layerWeights));

      biasInitializer = new NDArrayInitializer(Array1D.new(layerBias));

      return graph.layers.dense(
          'fully_connected_' + layerIndex, inputLayer, sizeOfThisLayer,
          (x) => graph.relu(x), true, weightsInitializer, biasInitializer);
    } else {
      console.log('Random initialisation');
      return graph.layers.dense(
          'fully_connected_' + layerIndex, inputLayer, sizeOfThisLayer,
          (x) => graph.relu(x), true );
    }

  }

  private getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private getRandom(min, max) {
    return Math.random() * (max - min) + min;
  }

  /**
   * Generates data used to train. Creates a feed entry that will later be used
   * to pass data into the model. Generates `exampleCount` data points.
   */
  private generateTrainingData(happyFaces: any, sadFaces: any) {
    this.math.scope(() => {
      const rawInputs = [...happyFaces, ...sadFaces];
      const rawTargets = [...happyFaces.map( f => 1 ), ...sadFaces.map( f => 0 )];
      console.log(rawInputs);
      // Store the data within Array1Ds so that learnjs can use it.
      const inputArray: Array1D[] =
          rawInputs.map(c => Array1D.new( c ));
      // const targetArray: Array1D[] = rawInputs.map(
      //     c => Array1D.new( [ c[0] + c[1] ] ) );
      const targetArray: Array1D[] = rawTargets.map( business => Array1D.new( [ business ] ) );

      // This provider will shuffle the training data (and will do so in a way
      // that does not separate the input-target relationship).
      const shuffledInputProviderBuilder =
          new InCPUMemoryShuffledInputProviderBuilder(
              [inputArray, targetArray]);
      const [inputProvider, targetProvider] =
          shuffledInputProviderBuilder.getInputProviders();

      // Maps tensors to InputProviders.
      this.feedEntries = [
        {tensor: this.inputTensor, data: inputProvider},
        {tensor: this.targetTensor, data: targetProvider}
      ];
    });
  }

  getWeights() {
    const nodeNames = [
      'fully_connected_0-weights',
      'fully_connected_0-bias',
      'fully_connected_1-weights',
      'fully_connected_1-bias',
      'fully_connected_2-weights',
      'fully_connected_2-bias',
      'fully_connected_3-weights',
      'fully_connected_3-bias',
    ];

    const nodes: any[] = this.graph.getNodes().filter( node => nodeNames.includes( node.name ) );
    const values = nodeNames.map( node => {
      return {
        name: node,
        values: this.session.activationArrayMap[ 'dict' ][ this.nodeMap[ node ] ].getValues()
      };
    } );
    console.log(this.session);
    // const node: any = nodes[ 2 ];
    const data = new File([JSON.stringify(values)], 'weights.json', {type: 'text/plain'});
    // FileSaver.saveAs( data );
  }


}